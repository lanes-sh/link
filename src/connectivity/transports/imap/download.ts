import { createHash } from 'node:crypto';
import {
  newHandle,
  putStaged,
  sweepStaged,
  STAGED_TTL_MS,
  type MailboxAttachmentSource,
} from '#connectivity/mail';
import type { ConnectionInfo, ToolResult } from '#connectivity';
import type { AuditLogger } from '#audit';
import type { BlobStore } from '#stores/blobs';

/**
 * Taking an attachment *out* of a mailbox.
 *
 * The direction that was missing. `get_message` reports what a message carries
 * — filename, type, size — and `send_message` can attach one back out, so an
 * attachment could be described and forwarded but never simply had. The two
 * routes people tried instead are both dead ends: storing it as an asset, which
 * cannot resolve a mailbox reference because a provider's store is scoped to
 * its own connection; and mailing it to yourself, which needs the message found
 * again by a header search some servers do badly.
 *
 * So this is the same staging the upload route already uses, run the other way.
 * The bytes are read here, put in *this connection's* namespace under a handle,
 * and the handle is what comes back. Nothing crosses between connections and no
 * provider gains reach it did not have — the bytes were already in this
 * account's area — and the client collects them over HTTP, out of band, exactly
 * as it hands them in.
 *
 * **The bytes never enter the tool result.** That is the whole rule of ADR-017
 * and it does not stop applying because the direction reversed: a 239 KB PDF is
 * about 320,000 characters of base64, and a model that has to read the file in
 * order to have it has not been handed anything.
 */
export async function getAttachment(
  attachments: MailboxAttachmentSource,
  args: Record<string, unknown>,
  audit: AuditLogger,
  storage: BlobStore,
  connection: ConnectionInfo,
): Promise<ToolResult> {
  const uid = typeof args['uid'] === 'number' ? args['uid'] : undefined;
  const messageId = typeof args['message_id'] === 'string' ? args['message_id'] : undefined;

  if (uid === undefined && messageId === undefined) {
    throw new Error(
      'Name the message: uid (with its mailbox, as search_messages reports both) or message_id.',
    );
  }
  if (uid !== undefined && messageId !== undefined) {
    throw new Error('Name the message by uid or by message_id, not both — they are alternatives.');
  }

  const mailbox = typeof args['mailbox'] === 'string' ? args['mailbox'] : undefined;
  const attachmentId =
    typeof args['attachment_id'] === 'string' ? args['attachment_id'] : undefined;

  const found = await attachments({ messageId, mailbox, uid, attachmentId });

  const filename = found.filename ?? 'attachment';
  const contentType = found.contentType ?? 'application/octet-stream';
  const sha256 = createHash('sha256').update(found.bytes).digest('hex');

  // Swept before writing, for the same reason the upload path sweeps: there is
  // no scheduler here, and staging is the only thing that makes this garbage.
  await sweepStaged(storage).catch(() => 0);

  const handle = newHandle();
  const expiresAt = Date.now() + STAGED_TTL_MS;

  await putStaged(storage, {
    handle,
    bytes: found.bytes,
    metadata: { filename, content_type: contentType, sha256, expires_at: expiresAt },
  });

  // The resolved facts rather than the arguments — identifiers, not content, the
  // same annotation the send path records. What makes "which file left this
  // mailbox" answerable is the name and the digest, not the bytes.
  audit.annotate({
    filename,
    bytes: found.bytes.byteLength,
    content_type: contentType,
    sha256,
    handle,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            handle,
            filename,
            bytes: found.bytes.byteLength,
            content_type: contentType,
            sha256,
            expires_at: new Date(expiresAt).toISOString(),
            connection: connection.key,
            fetch: `GET /attachments?connection=${connection.key}&handle=${handle}`,
            hint: `Download it with the GET above, or attach it to a message: { "handle": "${handle}" }. It is kept for 24 hours.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}
