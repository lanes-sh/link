import nodemailer from 'nodemailer';
import { composeMime, type ComposedMessage, type OutgoingMessage } from '#connectivity/mail';
import type { ImapCredential } from './client.ts';

/**
 * SMTP submission.
 *
 * Composition itself lives in `#connectivity/mail` — it grew a second caller
 * once an HTTP mail API needed the same assembled bytes, and one MIME builder is
 * the difference between one set of boundary bugs and two. What stays here is the
 * part that is actually SMTP: the envelope, the TLS decision, and the socket.
 *
 * The message is composed once and then both sent *and* appended, so the copy in
 * Sent is byte-identical to what the recipient got rather than a re-render of the
 * same intent.
 */

export interface SmtpTarget {
  readonly host: string;
  readonly port: number;
  readonly starttls: boolean;
  /** Largest encoded message this host accepts. See the manifest field. */
  readonly maxMessageBytes: number;
}

export type { OutgoingMessage };

/** What went out, and the exact bytes of it, for appending to Sent. */
export type SentMessage = ComposedMessage;

export type Sender = (input: {
  target: SmtpTarget;
  credential: ImapCredential;
  from: string;
  /**
   * The name shown beside the address.
   *
   * SMTP submits exactly what we compose — unlike an HTTP mail API, there is no
   * server-side step that fills in the account's own name — so without this the
   * `From` header is a bare address, which is what makes a sent message look
   * machine-generated.
   */
  fromName?: string | undefined;
  message: OutgoingMessage;
}) => Promise<SentMessage>;

export const sendOverSmtp: Sender = async ({
  target,
  credential,
  from,
  fromName,
  message,
}) => {
  const envelope = {
    from,
    to: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
  };

  // The envelope keeps the bare address: SMTP's MAIL FROM is a routing
  // identity, not a display one, and a name there is a protocol error.
  const built = await composeMime({ from, fromName, message });

  // Checked here rather than by the caller because this is the only point where
  // the real number exists: base64 expansion, headers and boundaries are all
  // decided by composition, so any earlier figure is an estimate. And it must be
  // before submission — a message refused part-way through `DATA` has already
  // cost the upload and reads like a dropped connection.
  if (built.raw.byteLength > target.maxMessageBytes) {
    throw new Error(
      `The composed message is ${built.raw.byteLength} bytes and ${target.host} accepts ${target.maxMessageBytes}. Attachments are base64 in transit, so they weigh about a third more than on disk.`,
    );
  }

  const transport = nodemailer.createTransport({
    host: target.host,
    port: target.port,
    // 465 is implicit TLS; 587 upgrades. `requireTLS` makes the upgrade
    // mandatory rather than best-effort — without it a downgrade would send the
    // password in the clear.
    secure: !target.starttls,
    requireTLS: target.starttls,
    auth: { user: credential.username, pass: credential.password },
  });

  try {
    await transport.sendMail({ raw: built.raw, envelope });
  } finally {
    transport.close();
  }

  return built;
};
