import PostalMime from 'postal-mime';
import type { MailboxAttachmentSource } from '#connectivity/mail';
import { quoted, type ImapClient, type ImapSession } from './client.ts';
import { asText, itemValue } from './parser.ts';
import { decodeMailboxName, encodeMailboxName } from './utf7.ts';

/**
 * Re-attaching an attachment that is already in the mailbox.
 *
 * This is the source worth having most, and the one the reported failure
 * actually needed: a PDF arrived by mail, and forwarding it should not require
 * the bytes to make a round trip through the model. Here they never leave the
 * process.
 *
 * Two ways to name the message, and the order of preference is the opposite of
 * the order they were built in.
 *
 * A **uid** — with the mailbox it belongs to — is what IMAP itself uses, and it
 * is already in front of the caller: `search_messages` reports both and
 * `get_message` takes both. One `EXAMINE` and one `UID FETCH`, no searching.
 *
 * A **Message-ID** obliges a search, because the caller has not said which folder
 * the message is in: INBOX first, since that is where it almost always is, then
 * the rest in the order the server lists them, matching on `HEADER MESSAGE-ID`.
 * That is a substring match the server implements however it likes, and a server
 * that implements it poorly answers "no such message" while holding the message.
 * It stays because a Message-ID survives being moved between folders and a uid
 * does not — but a caller holding a uid should send the uid.
 *
 * Kept out of `commands.ts` because that file is near the size budget and this is
 * a self-contained question — which bytes, given a Message-ID — rather than
 * another operation.
 */

/** Mailboxes we never search: a copy of the message is not the message. */
const SKIP_FLAGS = new Set(['\\trash', '\\junk']);

export function mailboxAttachments(client: ImapClient): MailboxAttachmentSource {
  return async ({ messageId, mailbox, uid, attachmentId }) =>
    client.run(async (session) => {
      const named = uid === undefined ? messageId : `uid ${uid} in ${mailbox ?? 'INBOX'}`;
      const bytes =
        uid === undefined
          ? await findMessageBytes(session, messageId!)
          : await fetchByUid(session, mailbox ?? 'INBOX', uid);

      if (!bytes) {
        throw new Error(
          uid === undefined
            ? `No message with Message-ID ${messageId} was found in this account. Every folder but Trash and Junk was searched, ` +
              `and some servers match the Message-ID header poorly — if search_messages or get_message reported a uid and a ` +
              `mailbox for this message, name those instead: { "uid": 1234, "mailbox": "INBOX" }.`
            : `No message with ${named} — a uid is only valid in the mailbox it was reported for, and stops being valid if the message moves.`,
        );
      }

      const mail = await PostalMime.parse(bytes);
      const attachments = mail.attachments;

      if (attachments.length === 0) {
        throw new Error(`Message ${named} has no attachments.`);
      }

      const chosen = pick(attachments, attachmentId, named!);

      return {
        bytes:
          typeof chosen.content === 'string'
            ? new TextEncoder().encode(chosen.content)
            : new Uint8Array(chosen.content),
        filename: chosen.filename ?? null,
        contentType: chosen.mimeType ?? null,
      };
    });
}

type ParsedAttachment = Awaited<ReturnType<typeof PostalMime.parse>>['attachments'][number];

/**
 * Which of a message's attachments was meant.
 *
 * By filename, or by 1-based position, or — when the message carries exactly one
 * — by there being no ambiguity to resolve. An unmatched name lists what is
 * actually there, because the alternative is a caller guessing twice.
 */
function pick(
  attachments: readonly ParsedAttachment[],
  attachmentId: string | undefined,
  messageId: string,
): ParsedAttachment {
  const names = attachments.map((entry, index) => entry.filename ?? `#${index + 1}`);

  if (attachmentId === undefined) {
    if (attachments.length === 1) return attachments[0]!;
    throw new Error(
      `Message ${messageId} has ${attachments.length} attachments, so attachment_id is needed. They are: ${names.join(', ')}.`,
    );
  }

  const exact = attachments.find((entry) => entry.filename === attachmentId);
  if (exact) return exact;

  const insensitive = attachments.find(
    (entry) => entry.filename?.toLowerCase() === attachmentId.toLowerCase(),
  );
  if (insensitive) return insensitive;

  const position = Number(attachmentId);
  if (Number.isInteger(position) && position >= 1 && position <= attachments.length) {
    return attachments[position - 1]!;
  }

  throw new Error(
    `Message ${messageId} has no attachment "${attachmentId}". They are: ${names.join(', ')}.`,
  );
}

/** INBOX, then every other mailbox, until one holds this Message-ID. */
async function findMessageBytes(
  session: ImapSession,
  messageId: string,
): Promise<Uint8Array | null> {
  for (const mailbox of await searchOrder(session)) {
    const bytes = await fetchByMessageId(session, mailbox, messageId);
    if (bytes) return bytes;
  }
  return null;
}

async function searchOrder(session: ImapSession): Promise<string[]> {
  const result = await session.command('LIST "" "*"');

  const mailboxes: string[] = [];
  for (const tokens of result.untagged) {
    if (asText(tokens[1]) !== 'LIST') continue;

    const flags = tokens[2]?.kind === 'list' ? tokens[2].items : [];
    if (flags.some((flag) => SKIP_FLAGS.has(asText(flag)?.toLowerCase() ?? ''))) continue;
    // `\Noselect` names a folder that only holds other folders; EXAMINE fails on
    // it, which would abort the walk before reaching the mailbox we want.
    if (flags.some((flag) => asText(flag)?.toLowerCase() === '\\noselect')) continue;

    const name = decodeMailboxName(asText(tokens[4]) ?? '');
    if (name) mailboxes.push(name);
  }

  const rest = mailboxes.filter((name) => name.toUpperCase() !== 'INBOX');
  return ['INBOX', ...rest];
}

async function fetchByMessageId(
  session: ImapSession,
  mailbox: string,
  messageId: string,
): Promise<Uint8Array | null> {
  try {
    // EXAMINE and BODY.PEEK throughout: looking for something to attach must not
    // mark mail as read, which is the same rule every read path here follows.
    await session.command(`EXAMINE ${quoted(encodeMailboxName(mailbox))}`);
  } catch {
    return null;
  }

  // Angle brackets stripped because servers disagree about whether the stored
  // header value includes them, and HEADER matching is a substring test.
  const bare = messageId.replace(/^</, '').replace(/>$/, '');
  const found = await session.command(`UID SEARCH HEADER MESSAGE-ID ${quoted(bare)}`);

  const uid = found.untagged
    .filter((tokens) => asText(tokens[1]) === 'SEARCH')
    .flatMap((tokens) => tokens.slice(2).map((token) => Number(asText(token))))
    .find((value) => Number.isFinite(value));

  if (uid === undefined) return null;

  return await fetchBody(session, uid);
}

/**
 * The direct route: the caller already knows which mailbox and which uid.
 *
 * `EXAMINE` rather than `SELECT`, and `BODY.PEEK[]` rather than `BODY[]`, for the
 * same reason as every other read here — fetching something to attach must not
 * mark it as read.
 */
async function fetchByUid(
  session: ImapSession,
  mailbox: string,
  uid: number,
): Promise<Uint8Array | null> {
  try {
    await session.command(`EXAMINE ${quoted(encodeMailboxName(mailbox))}`);
  } catch {
    return null;
  }

  return await fetchBody(session, uid);
}

async function fetchBody(session: ImapSession, uid: number): Promise<Uint8Array | null> {
  const fetched = await session.command(`UID FETCH ${uid} (BODY.PEEK[])`);
  const record = fetched.untagged.find(
    (tokens) => asText(tokens[2]) === 'FETCH' && tokens[3]?.kind === 'list',
  );
  if (!record || record[3]?.kind !== 'list') return null;

  const body = itemValue(record[3].items, 'BODY');
  return body?.kind === 'literal' ? body.bytes : null;
}
