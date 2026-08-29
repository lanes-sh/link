import type { MailboxAttachmentSource } from '#connectivity/mail';
import { GMAIL_API } from './api.ts';

/**
 * Re-attaching an attachment that is already in the mailbox.
 *
 * Two round trips rather than one, deliberately. `attachments.get` returns
 * `{attachmentId, size, data}` and nothing else — no filename, no MIME type — so
 * fetching only the bytes would produce an attachment called "attachment" of no
 * particular type. The message metadata is where the part headers live, so it is
 * read first, and it also lets a caller name the attachment by filename or omit
 * the id when there is only one.
 *
 * The sharp edge here is the encoding. Gmail returns `data` as base64**url** (RFC
 * 4648 §5), not standard base64. Handing that to a MIME composer that expects the
 * standard alphabet corrupts any file containing a byte that encodes to `-` or
 * `_` — which is most of them — and the result still arrives, still has the right
 * length, and still opens as a file. It is a silent, plausible failure, and it is
 * a known trap in other implementations of this same feature.
 */
export function gmailAttachments(input: {
  readonly authorize: (request: Request) => Promise<Request>;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}): MailboxAttachmentSource {
  const doFetch = input.fetch ?? globalThis.fetch;

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const request = await input.authorize(
      new Request(`${GMAIL_API}${path}`, {
        headers: { accept: 'application/json' },
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );

    const response = await doFetch(request);
    if (!response.ok) {
      throw new Error(`Gmail answered ${response.status} for ${path}: ${await response.text()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };

  return async ({ messageId, uid, attachmentId }) => {
    // Gmail's REST API has no mailbox uid — a message is named by the id
    // `messages.list` reports, and a label is not a folder to EXAMINE. Saying so
    // and naming the key that does work is the whole job here: the alternative
    // is a caller who read "uid" in the shared schema getting a 404 from Google
    // that explains nothing.
    if (uid !== undefined) {
      throw new Error(
        'Gmail names a message by its id rather than a mailbox uid. Use message_id, with the id ' +
          'gmail.users_messages_list reports. A uid belongs to the IMAP providers — gmail_imap, icloud_mail, fastmail_mail.',
      );
    }
    if (messageId === undefined) {
      throw new Error('Re-attaching from Gmail needs message_id.');
    }

    const message = await get(`/messages/${encodeURIComponent(messageId)}?format=full`);
    const parts = attachmentParts(message['payload']);

    if (parts.length === 0) throw new Error(`Message ${messageId} has no attachments.`);

    const chosen = pick(parts, attachmentId, messageId);
    const body = await get(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(chosen.attachmentId)}`,
    );

    const data = body['data'];
    if (typeof data !== 'string') {
      throw new Error(`Gmail returned no content for attachment ${chosen.attachmentId}.`);
    }

    return {
      // base64url in, bytes out. See the note above.
      bytes: new Uint8Array(Buffer.from(data, 'base64url')),
      filename: chosen.filename,
      contentType: chosen.mimeType,
    };
  };
}

interface AttachmentPart {
  readonly attachmentId: string;
  readonly filename: string | null;
  readonly mimeType: string | null;
}

/**
 * Every part that is a file, from anywhere in the tree.
 *
 * Recursive because a message with both a body and attachments nests them —
 * `multipart/mixed` holding a `multipart/alternative` holding the text — so the
 * files are rarely at the top level.
 */
function attachmentParts(payload: unknown): AttachmentPart[] {
  if (payload === null || typeof payload !== 'object') return [];

  const part = payload as {
    filename?: unknown;
    mimeType?: unknown;
    body?: { attachmentId?: unknown };
    parts?: unknown;
  };

  const found: AttachmentPart[] = [];

  const attachmentId = part.body?.attachmentId;
  if (typeof attachmentId === 'string' && attachmentId !== '') {
    found.push({
      attachmentId,
      filename: typeof part.filename === 'string' && part.filename !== '' ? part.filename : null,
      mimeType: typeof part.mimeType === 'string' ? part.mimeType : null,
    });
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) found.push(...attachmentParts(child));
  }

  return found;
}

/** By filename, by position, or by there being only one. Mirrors the IMAP side. */
function pick(
  parts: readonly AttachmentPart[],
  attachmentId: string | undefined,
  messageId: string,
): AttachmentPart {
  const names = parts.map((part, index) => part.filename ?? `#${index + 1}`);

  if (attachmentId === undefined) {
    if (parts.length === 1) return parts[0]!;
    throw new Error(
      `Message ${messageId} has ${parts.length} attachments, so attachment_id is needed. They are: ${names.join(', ')}.`,
    );
  }

  // Gmail's own opaque id, which is what `get_message` reports, so it is the
  // most likely thing a caller passes.
  const byId = parts.find((part) => part.attachmentId === attachmentId);
  if (byId) return byId;

  const byName = parts.find(
    (part) => part.filename?.toLowerCase() === attachmentId.toLowerCase(),
  );
  if (byName) return byName;

  const position = Number(attachmentId);
  if (Number.isInteger(position) && position >= 1 && position <= parts.length) {
    return parts[position - 1]!;
  }

  throw new Error(
    `Message ${messageId} has no attachment "${attachmentId}". They are: ${names.join(', ')}.`,
  );
}
