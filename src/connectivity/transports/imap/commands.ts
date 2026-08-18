import PostalMime from 'postal-mime';
import type { AuditLogger } from '#audit';
import type { ConnectionInfo, ToolResult } from '#connectivity';
import type { BlobStore } from '#stores/blobs';
import { receiptFor, resolveAttachments } from '#connectivity/mail';
import { mailboxAttachments } from './attachment.ts';
import { quoted, type ImapClient, type ImapSession } from './client.ts';
import { asText, itemValue } from './parser.ts';
import { decodeMailboxName, encodeMailboxName } from './utf7.ts';
import type { Sender, SmtpTarget } from './send.ts';
import { error, json } from './result.ts';
import { SETTABLE_FLAGS } from './operations.ts';
import type { ImapConnectorOptions } from './index.ts';
import {
  addressList,
  formatAddress,
  allowedFlags,
  envelopeSummary,
  flagList,
  searchCriteria,
  stripHtml,
  uidList,
} from './parse.ts';

/**
 * The seven operations, as free functions over a session.
 *
 * Separate from `index.ts` because the connector's job is to open a session and
 * pick one of these; theirs is to know what a mailbox can do.
 */


export async function listMailboxes(
  session: ImapSession,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const pattern = String(args['pattern'] ?? '*');
  const result = await session.command(`LIST "" ${quoted(encodeMailboxName(pattern))}`);

  const mailboxes = result.untagged
    .filter((tokens) => asText(tokens[1]) === 'LIST')
    .map((tokens) => {
      const flags = tokens[2]?.kind === 'list' ? tokens[2].items : [];
      return {
        name: decodeMailboxName(asText(tokens[4]) ?? ''),
        delimiter: asText(tokens[3]) ?? null,
        // `\Sent`, `\Drafts`, `\Junk` and friends: the only reliable way to know
        // which folder is which, since the *names* are localised.
        flags: flags.map((flag) => asText(flag)).filter(Boolean),
      };
    });

  return json({ mailboxes });
}

export async function searchMessages(
  session: ImapSession,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const name = String(args['mailbox'] ?? 'INBOX');
  const limit = Math.min(Number(args['limit'] ?? 25) || 25, 100);

  // EXAMINE, not SELECT: read-only by construction rather than by care.
  await session.command(`EXAMINE ${quoted(encodeMailboxName(name))}`);

  const criteria = searchCriteria(args);
  const found = await session.command(`UID SEARCH ${criteria}`);

  const uids = found.untagged
    .filter((tokens) => asText(tokens[1]) === 'SEARCH')
    .flatMap((tokens) => tokens.slice(2).map((token) => Number(asText(token))))
    .filter((uid) => Number.isFinite(uid));

  if (uids.length === 0) return json({ mailbox: name, criteria, messages: [] });

  // Highest UIDs are the most recent, and the tail is what anyone means by
  // "search my mail" — asking for all of a 40,000-message mailbox is not.
  const wanted = uids.slice(-limit).reverse();

  const fetched = await session.command(
    `UID FETCH ${wanted.join(',')} (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)`,
  );

  const byUid = new Map<number, Record<string, unknown>>();
  for (const tokens of fetched.untagged) {
    if (asText(tokens[2]) !== 'FETCH' || tokens[3]?.kind !== 'list') continue;
    const items = tokens[3].items;
    const uid = Number(asText(itemValue(items, 'UID')));
    if (!Number.isFinite(uid)) continue;

    byUid.set(uid, {
      uid,
      date: asText(itemValue(items, 'INTERNALDATE')) ?? null,
      size: Number(asText(itemValue(items, 'RFC822.SIZE'))) || null,
      flags: flagList(itemValue(items, 'FLAGS')),
      ...envelopeSummary(itemValue(items, 'ENVELOPE')),
    });
  }

  return json({
    mailbox: name,
    criteria,
    messages: wanted.map((uid) => byUid.get(uid)).filter(Boolean),
  });
}

export async function getMessage(
  session: ImapSession,
  args: Readonly<Record<string, unknown>>,
  maxBodyBytes: number,
): Promise<ToolResult> {
  const name = String(args['mailbox'] ?? 'INBOX');
  const uid = Number(args['uid']);
  if (!Number.isFinite(uid)) return error('uid is required and must be a number.');

  await session.command(`EXAMINE ${quoted(encodeMailboxName(name))}`);

  // BODY.PEEK, not BODY: fetching the body must not silently mark the message
  // read behind the operator's back.
  const fetched = await session.command(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[])`);

  const record = fetched.untagged.find(
    (tokens) => asText(tokens[2]) === 'FETCH' && tokens[3]?.kind === 'list',
  );
  if (!record || record[3]?.kind !== 'list') {
    return error(`No message with UID ${uid} in ${name}.`);
  }

  const items = record[3].items;
  const body = itemValue(items, 'BODY');
  if (!body || body.kind !== 'literal') return error(`Message ${uid} returned no body.`);

  const mail = await PostalMime.parse(body.bytes);

  const text = mail.text ?? (mail.html ? stripHtml(mail.html) : '');
  const truncated = text.length > maxBodyBytes;

  return json({
    uid,
    mailbox: name,
    flags: flagList(itemValue(items, 'FLAGS')),
    subject: mail.subject ?? null,
    from: mail.from ? formatAddress(mail.from) : null,
    to: (mail.to ?? []).map(formatAddress),
    cc: (mail.cc ?? []).map(formatAddress),
    date: mail.date ?? null,
    message_id: mail.messageId ?? null,
    in_reply_to: mail.inReplyTo ?? null,
    ...(args['include_body'] === false
      ? {}
      : {
          body: truncated
            ? `${text.slice(0, maxBodyBytes)}\n[truncated — ${text.length - maxBodyBytes} more characters]`
            : text,
          body_truncated: truncated,
        }),
    // Metadata only. Handing over attachment *content* needs somewhere for an
    // agent to fetch bytes from, which is what MCP resources are for and does
    // not exist yet — so this says what is there rather than pretending.
    attachments: mail.attachments.map((attachment) => ({
      filename: attachment.filename ?? null,
      mime_type: attachment.mimeType,
      bytes:
        typeof attachment.content === 'string'
          ? attachment.content.length
          : attachment.content.byteLength,
    })),
  });
}

export async function markMessages(
  session: ImapSession,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const name = String(args['mailbox'] ?? 'INBOX');
  const uids = uidList(args['uids']);
  if (uids.length === 0) return error('uids must list at least one message.');

  const add = allowedFlags(args['add_flags']);
  const remove = allowedFlags(args['remove_flags']);
  if (add.length === 0 && remove.length === 0) {
    return error(`Nothing to change. Settable flags are ${SETTABLE_FLAGS.join(' ')}.`);
  }

  await session.command(`SELECT ${quoted(encodeMailboxName(name))}`);
  if (add.length > 0) await session.command(`UID STORE ${uids.join(',')} +FLAGS (${add.join(' ')})`);
  if (remove.length > 0) {
    await session.command(`UID STORE ${uids.join(',')} -FLAGS (${remove.join(' ')})`);
  }

  return json({ mailbox: name, uids, added: add, removed: remove });
}

export async function moveMessages(
  session: ImapSession,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const name = String(args['mailbox'] ?? 'INBOX');
  const named = args['destination'] === undefined ? '' : String(args['destination']);
  const flag = args['destination_flag'] === undefined ? '' : String(args['destination_flag']);
  const uids = uidList(args['uids']);

  // Exactly one, refused rather than resolved by precedence. ADR-017 makes the
  // same call on attachment sources, for the same reason: silently preferring
  // one would make the other look like it worked, and which folder the mail
  // went to is the last thing anyone thinks to check.
  if (named && flag) {
    return error('Pass either destination or destination_flag, not both.');
  }
  if (!named && !flag) return error('destination or destination_flag is required.');
  if (uids.length === 0) return error('uids must list at least one message.');

  let destination = named;
  if (flag) {
    const resolved = await findMailboxByFlag(session, flag);
    if (!resolved) {
      const available = await mailboxNames(session);
      return error(
        `No mailbox advertises ${flag}. LIST reported: ${available.join(', ') || 'nothing'}. ` +
          'Pass destination with one of those names instead.',
      );
    }
    destination = resolved;
  }

  await session.command(`SELECT ${quoted(encodeMailboxName(name))}`);
  // UID MOVE only, never emulated with COPY + \Deleted + EXPUNGE: that fallback
  // is how a failed move becomes deleted mail.
  await session.command(`UID MOVE ${uids.join(',')} ${quoted(encodeMailboxName(destination))}`);

  return json({ moved: uids.length, from: name, to: destination });
}

export async function sendMessage(
  client: ImapClient,
  options: ImapConnectorOptions,
  send: Sender,
  args: Readonly<Record<string, unknown>>,
  audit: AuditLogger,
  storage: BlobStore,
  connection: ConnectionInfo,
): Promise<ToolResult> {
  if (!options.smtp) return error('This account has no SMTP server configured, so it cannot send.');

  const to = (args['to'] as string[] | undefined) ?? [];
  if (to.length === 0) return error('to must list at least one recipient.');

  // Resolved before the credential is touched, because this is the step that
  // fails on a caller's mistake — a wrong path, a URL that will not fetch — and
  // failing there should not have opened a session or a socket first.
  //
  // The budget is three quarters of what the host accepts: attachments travel
  // base64, so this is the raw weight that fits once encoded. The composed
  // message is measured exactly below; this only avoids reading megabytes to then
  // refuse them.
  const encodedLimit = options.smtp.maxMessageBytes;
  const attachments = await resolveAttachments(args['attachments'], {
    maxTotalBytes: Math.floor((encodedLimit * 3) / 4),
    mailbox: mailboxAttachments(client),
    storage,
  });

  // Recorded before the send, so an attachment that was read off disk is in the
  // log even if submission then fails. `redact` cannot express this: it can only
  // keep an argument verbatim, and the raw argument may be an inline base64 file
  // — the last thing an audit log should grow. These are the resolved facts
  // instead, which is what `annotate` is for.
  if (attachments.length > 0) {
    audit.annotate({
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        bytes: attachment.bytes.byteLength,
        content_type: attachment.contentType,
        sha256: attachment.sha256,
        origin: attachment.origin,
      })),
    });
  }

  // The call wins, then the connection's own default. Neither is invented: with
  // nothing configured the header stays a bare address rather than guessing a
  // name for someone, which would be worse than showing none.
  const configured = connection.config['from_name'];
  const fromName =
    (args['from_name'] as string | undefined) ??
    (typeof configured === 'string' && configured.trim() !== '' ? configured : undefined);

  const credential = await options.credential();
  const sent = await send({
    target: options.smtp,
    credential,
    from: credential.username,
    ...(fromName ? { fromName } : {}),
    message: {
      to,
      cc: args['cc'] as string[] | undefined,
      bcc: args['bcc'] as string[] | undefined,
      subject: String(args['subject'] ?? ''),
      text: args['text'] as string | undefined,
      html: args['html'] as string | undefined,
      inReplyTo: args['in_reply_to'] as string | undefined,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  });

  // File a copy, best effort. The message is already delivered by this point, so
  // a failure to append is worth reporting but must not read as a failure to
  // send — that would have someone send it a second time.
  let filed: string | null = null;
  try {
    filed = await client.run(
      async (session) => {
        const sentMailbox = await findSentMailbox(session);
        if (!sentMailbox) return null;
        await session.commandWithLiteral(
          `APPEND ${quoted(encodeMailboxName(sentMailbox))} (\\Seen) {${sent.raw.length}}`,
          sent.raw,
        );
        return sentMailbox;
      },
      { retry: false },
    );
  } catch {
    filed = null;
  }

  const cc = (args['cc'] as string[] | undefined) ?? [];

  return json({
    sent: true,
    message_id: sent.messageId,
    recipients: to.length + cc.length,
    filed_in: filed,
    // Names, sizes and digests, never content. What went out is worth confirming
    // — a caller that named a path deserves to know which file it got — but
    // handing the bytes back would undo the point of resolving them here.
    ...(attachments.length > 0 ? { attachments: attachments.map(receiptFor) } : {}),
    ...(filed ? {} : { note: 'Sent, but no copy could be filed in the Sent mailbox.' }),
  });
}

/**
 * Which mailbox carries a given special-use attribute.
 *
 * By the flag, never by name: iCloud calls Sent `Sent Messages`, Gmail
 * `[Gmail]/Sent Mail`, and a German Dovecot `Gesendet`. Hardcoding any of those
 * is how a sent copy silently stops being filed — and Junk has the same trap
 * with more spellings, which is what generalised this from `findSentMailbox`.
 */
export async function findMailboxByFlag(
  session: ImapSession,
  flag: string,
): Promise<string | null> {
  const wanted = flag.toLowerCase();
  const result = await session.command('LIST "" "*"');

  for (const tokens of result.untagged) {
    if (asText(tokens[1]) !== 'LIST') continue;
    const flags = tokens[2]?.kind === 'list' ? tokens[2].items : [];
    if (flags.some((candidate) => asText(candidate)?.toLowerCase() === wanted)) {
      return decodeMailboxName(asText(tokens[4]) ?? '');
    }
  }

  return null;
}

/** Which mailbox is "Sent" — the send path's single caller of the above. */
export async function findSentMailbox(session: ImapSession): Promise<string | null> {
  return findMailboxByFlag(session, '\\Sent');
}

/** Every mailbox name LIST reported, for an error that can say what was there. */
async function mailboxNames(session: ImapSession): Promise<string[]> {
  const result = await session.command('LIST "" "*"');
  return result.untagged
    .filter((tokens) => asText(tokens[1]) === 'LIST')
    .map((tokens) => decodeMailboxName(asText(tokens[4]) ?? ''))
    .filter((name) => name.length > 0);
}

// ---------------------------------------------------------------------------
// Shaping arguments and results
// ---------------------------------------------------------------------------

