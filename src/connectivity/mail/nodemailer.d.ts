/**
 * Types for the sliver of nodemailer this codebase uses.
 *
 * Declared here rather than by adding `@types/nodemailer`, which is a large
 * surface tracking its own version and would be a second dependency to keep
 * honest — in a repository that has six, holds live credentials, and enforces a
 * release-age floor for exactly that reason.
 *
 * **It does not verify itself, and this comment used to claim it did.** An
 * ambient `declare module` overrides the types a package ships, so from 10.x —
 * which ships its own, where 9.x shipped none — `tsc` checks every call against
 * the assumption written here and never against nodemailer's actual exports. A
 * changed signature in the surface below compiles clean and fails at runtime.
 * So this file is a convenience, not a guarantee, and the thing that actually
 * holds the two together is `mail.test.ts` composing a real message through a
 * real transport and asserting the bytes.
 *
 * Deleting it in favour of the shipped types is the better end state and was
 * tried: 10.x types `content` as `Buffer` where this passes `Uint8Array`, and
 * `sendMail` as `Promise<StreamSentMessageInfo> & void`, so it is five call-site
 * changes in `compose.ts` and `imap/send.ts` rather than a deletion. That is its
 * own change, not a dependency bump's.
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
