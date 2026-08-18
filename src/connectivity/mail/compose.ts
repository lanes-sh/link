import nodemailer from 'nodemailer';
import type { ComposedMessage, OutgoingMessage } from './message.ts';

/**
 * Turn a message into the bytes that will go out.
 *
 * Nodemailer rather than a hand-rolled builder, and the reasoning is the same one
 * that admits `postal-mime` on the reading side: the protocol talk is short and
 * stable, but *composition* is not. Quoted-printable, the 998-octet line limit,
 * RFC 2047 encoded-words in a subject, `multipart/mixed` boundaries that must not
 * occur in any part body (RFC 2046 §5.1.1), base64 wrapped at 76 columns (RFC
 * 2045 §6.8), `Content-Disposition` filenames, `Message-ID` and `Date` — each
 * fails quietly and partially, which is the worst way for mail to break. It is
 * zero-dependency and MIT-0, so accepting it costs nothing but the name.
 *
 * `streamTransport` with `buffer` composes without sending. That was originally
 * so the copy filed in Sent is byte-identical to what the recipient got rather
 * than a re-render of the same intent; it is now also how an HTTP mail API gets
 * a message to base64url, since those APIs take assembled MIME and will not
 * assemble it for you.
 */
export async function composeMime(input: {
  /**
   * Omit to leave the `From` header off entirely.
   *
   * SMTP always has one — it is the authenticated account, and the envelope needs
   * it. An HTTP mail API does not: it fills the header from the credential, and
   * guessing a value to hand it risks writing an address the account is not
   * allowed to send as.
   */
  readonly from?: string | undefined;
  /**
   * The human name to show beside the address — "Ada Lovelace <a@b>".
   *
   * Its absence is why a sent message can look machine-generated: a bare address
   * is what a recipient sees when nothing supplies one. It is not a spam signal
   * on its own (alignment and DKIM decide that), but it is the difference between
   * mail from a person and mail from a process.
   *
   * Passed as a structured pair rather than a pre-joined string so nodemailer
   * does the RFC 2047 encoding — a name with an accent or a comma in it needs it,
   * and hand-joining is where that breaks.
   */
  readonly fromName?: string | undefined;
  readonly message: OutgoingMessage;
}): Promise<ComposedMessage> {
  const { from, fromName, message } = input;

  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const built = await composer.sendMail({
    ...(from ? { from: fromName ? { name: fromName, address: from } : from } : {}),
    to: [...message.to],
    ...(message.cc?.length ? { cc: [...message.cc] } : {}),
    ...(message.bcc?.length ? { bcc: [...message.bcc] } : {}),
    subject: message.subject,
    ...(message.text ? { text: message.text } : {}),
    ...(message.html ? { html: message.html } : {}),
    // Threading is two headers, and clients that only read one of them are
    // common enough that setting just `In-Reply-To` orphans the reply.
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo, references: [message.inReplyTo] } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.bytes,
            contentType: attachment.contentType,
          })),
        }
      : {}),
  });

  return { messageId: built.messageId, raw: new Uint8Array(built.message) };
}
