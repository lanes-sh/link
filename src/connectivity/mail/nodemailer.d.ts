/**
 * Types for the sliver of nodemailer this codebase uses.
 *
 * Declared here rather than by adding `@types/nodemailer`, which is a large
 * surface tracking its own version and would be a second dependency to keep
 * honest — in a repository that has six, holds live credentials, and enforces a
 * release-age floor for exactly that reason. What we call is a few fields wide
 * and stable; if that stops being true, this file fails to compile, which is the
 * behaviour we want.
 *
 * Moved here from `transports/imap/` when a second caller appeared: an HTTP mail
 * API needs the same composed bytes SMTP does, so composition outgrew the
 * transport that first needed it.
 */
declare module 'nodemailer' {
  interface Envelope {
    from: string;
    to: string[];
  }

  /**
   * One attachment. `content` takes the raw bytes — nodemailer picks the
   * transfer encoding and wraps base64 at 76 columns per RFC 2045 §6.8, which is
   * the kind of detail that corrupts a PDF quietly when hand-rolled.
   */
  interface Attachment {
    filename?: string;
    content?: Buffer | Uint8Array | string;
    contentType?: string;
    encoding?: string;
    cid?: string;
  }

  /** A display name plus an address. Nodemailer encodes the name if it needs it. */
  interface Address {
    name: string;
    address: string;
  }

  interface Message {
    from?: string | Address;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: Attachment[];
    /** A pre-composed RFC 822 message, sent verbatim. */
    raw?: Buffer | Uint8Array;
    envelope?: Envelope;
  }

  interface SentInfo {
    messageId: string;
    /** Present with `streamTransport` + `buffer`: the composed message. */
    message: Buffer;
  }

  interface Transport {
    sendMail(message: Message): Promise<SentInfo>;
    close(): void;
  }

  interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    requireTLS?: boolean;
    auth?: { user: string; pass: string };
    /** Compose without sending, which is how the Sent copy stays identical. */
    streamTransport?: boolean;
    buffer?: boolean;
  }

  const nodemailer: {
    createTransport(options: TransportOptions): Transport;
  };

  export default nodemailer;
}
