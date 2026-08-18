/**
 * Mail composition, shared by every transport that sends it.
 *
 * A third folder beside `transports/` and `auth/`, and it earns the place by
 * being needed from both sides of that split: SMTP composes and submits in one
 * step, while an HTTP mail API wants assembled MIME handed to it as a field. The
 * alternative was a second MIME builder, which is a second set of boundary and
 * transfer-encoding bugs.
 *
 * Nothing here names a vendor.
 */

export type {
  AttachmentReceipt,
  ComposedMessage,
  OutgoingMessage,
  ResolvedAttachment,
} from './message.ts';
export { receiptFor } from './message.ts';

export { composeMime } from './compose.ts';

export type { AttachmentRef, MailboxAttachmentSource, ResolveOptions } from './attachments.ts';
export { attachmentRefSchema, attachmentsJsonSchema, resolveAttachments } from './attachments.ts';

export type { StagedFile, StagedMetadata } from './staging.ts';
export {
  getStaged,
  isHandle,
  newHandle,
  putStaged,
  stagedBytesKey,
  stagedMetaKey,
  sweepStaged,
  STAGED_PREFIX,
  STAGED_TTL_MS,
} from './staging.ts';

export type { AddressLookup, FetchedFile } from './url.ts';
export { fetchFromUrl, isBlocked } from './url.ts';
