/**
 * What an outgoing message is, independent of how it gets sent.
 *
 * Its own folder because two transports now compose one: SMTP submits the bytes
 * itself, and an HTTP mail API wants the same bytes base64url'd into a JSON
 * field. Both need identical MIME, and a second composer would be a second set
 * of quoted-printable and boundary bugs.
 *
 * No vendor name here, and none in the files beside it — this is protocol, and
 * `architecture.test.ts` checks that claim.
 */

/**
 * An attachment with its bytes in hand.
 *
 * The resolver produces these; a composer consumes them. By the time one exists
 * the reference has already been read, fetched, or pulled from a mailbox, so
 * nothing downstream needs to know which it was.
 */
export interface ResolvedAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /**
   * Hex SHA-256 of `bytes`.
   *
   * Carried on the resolved attachment rather than recomputed by each caller
   * because both consumers want it: the audit log records it, and the tool
   * result hands it back as a receipt. Computing it twice from the same buffer
   * would be waste, and computing it in only one place is how the two disagree.
   */
  readonly sha256: string;
  /**
   * Where the bytes came from, for the audit log — `path:/Users/…`,
   * `url:https://…`, `mailbox:18f…`, `handle:att_…`, or `inline`.
   *
   * A description, never something to parse. It exists because with unrestricted
   * paths this string is the only record of which file left the machine.
   */
  readonly origin: string;
}

export interface OutgoingMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly subject: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly attachments?: readonly ResolvedAttachment[] | undefined;
}

/** The exact bytes of a composed message, before anything transmits them. */
export interface ComposedMessage {
  readonly messageId: string;
  readonly raw: Uint8Array;
}

/**
 * What a send reports about one attachment.
 *
 * Deliberately not the bytes. Echoing content back would rebuild the
 * context-window problem this whole path exists to avoid, and — because a
 * `path` attachment may name any readable file — it would turn a send tool into
 * a general file-read tool by way of the result.
 */
export interface AttachmentReceipt {
  readonly filename: string;
  readonly bytes: number;
  readonly content_type: string;
  readonly sha256: string;
}

export function receiptFor(attachment: ResolvedAttachment): AttachmentReceipt {
  return {
    filename: attachment.filename,
    bytes: attachment.bytes.byteLength,
    content_type: attachment.contentType,
    sha256: attachment.sha256,
  };
}
