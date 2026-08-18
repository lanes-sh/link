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
 * A message is named by its RFC 2822 `Message-ID` rather than by UID, because
 * that is what `get_message` and `search_messages` already report and it does not
 * oblige the caller to also remember which folder the message was in. The cost is
 * a search: INBOX first, since that is where it almost always is, then the rest
 * of the folders in the order the server lists them.
 *
 * Kept out of `commands.ts` because that file is near the size budget and this is
 * a self-contained question — which bytes, given a Message-ID — rather than
 * another operation.
 */

/** Mailboxes we never search: a copy of the message is not the message. */
const SKIP_FLAGS = new Set(['\\trash', '\\junk']);

export function mailboxAttachments(client: ImapClient): MailboxAttachmentSource {
  return async ({ messageId, attachmentId }) =>
    client.run(async (session) => {
      const bytes = await findMessageBytes(session, messageId);
      if (!bytes) {
        throw new Error(
          `No message with Message-ID ${messageId} in this account, so its attachment cannot be re-attached.`,
        );
      }

      const mail = await PostalMime.parse(bytes);
      const attachments = mail.attachments;

      if (attachments.length === 0) {
        throw new Error(`Message ${messageId} has no attachments.`);
      }

      const chosen = pick(attachments, attachmentId, messageId);

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

  const fetched = await session.command(`UID FETCH ${uid} (BODY.PEEK[])`);
  const record = fetched.untagged.find(
    (tokens) => asText(tokens[2]) === 'FETCH' && tokens[3]?.kind === 'list',
  );
  if (!record || record[3]?.kind !== 'list') return null;

  const body = itemValue(record[3].items, 'BODY');
  return body?.kind === 'literal' ? body.bytes : null;
}
