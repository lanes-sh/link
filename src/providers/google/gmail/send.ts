import { z } from 'zod';
import type { ProviderContext, ToolCapability, ToolResult } from '#connectivity';
import {
  attachmentRefSchema,
  composeMime,
  receiptFor,
  resolveAttachments,
  type ResolvedAttachment,
} from '#connectivity/mail';
import {
  GMAIL_API,
  GMAIL_JSON_LIMIT_BYTES,
  GMAIL_MAX_MESSAGE_BYTES,
  GMAIL_UPLOAD,
} from './api.ts';
import { gmailAttachments } from './attachment.ts';

/**
 * Sending mail, composed here rather than by the caller.
 *
 * The one capability on this provider that is code instead of data, and the
 * reason is narrow: Gmail's API takes a whole assembled RFC 2822 message as one
 * base64url field. Nothing in an OpenAPI document describes composing one, so the
 * generated tools hand that job to the caller — which for a plain message is
 * merely absurd, and for a message with an attachment is impossible. A 239 KB PDF
 * is about 320,000 characters of base64, past what a model can write in one
 * message. That is a real failure someone hit, not a hypothetical.
 *
 * Note there was no send tool here at all before this. The omission was
 * deliberate — "the token can send, the tool surface cannot" — and reversing it
 * is the point of the change rather than an accident of it. `gmail.compose`
 * already permits it, `draft_only` keeps the review step available, and
 * `lanes link policy deny gmail.send_message` still takes it away.
 *
 * `draft_id` extends the same argument to revising one. The generated
 * `drafts.update` had the identical defect its sibling `drafts.create` was
 * removed for — a `Draft` body whose `message.raw` the caller assembles — so
 * correcting a draft that carried a file meant deleting it and composing the
 * whole thing again, re-fetching every attachment on the way. Here the message
 * is recomposed as it always was and the only difference is the address it goes
 * to: a `PUT` at the draft rather than a `POST` at the collection.
 *
 * Sending after a revision is two requests rather than one. Gmail's
 * `drafts.send` does accept a whole `Draft`, which would fold the update into
 * the send, but the merge semantics are not something this code can verify from
 * here — and the failure mode if they are not what one assumed is that the
 * *previous* draft goes out, silently, to real recipients. Updating and then
 * sending by id costs a round trip on a path already measured in seconds, and
 * both halves are documented single-purpose calls.
 */

const schema = z.object({
  to: z.array(z.string()).min(1).describe('Recipients.'),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  text: z.string().optional().describe('Plain-text body.'),
  html: z.string().optional().describe('HTML body. Send text as well where you can.'),
  in_reply_to: z
    .string()
    .optional()
    .describe('Message-ID being replied to, which threads the reply.'),
  from_name: z
    .string()
    .optional()
    .describe(
      'Name to show beside the address. Rarely needed here — omitted, Gmail fills in the account\'s own name — so pass it only to send under a different one.',
    ),
  attachments: z
    .array(attachmentRefSchema)
    .optional()
    .describe(
      'Files to attach, each named by reference. This endpoint reads the bytes itself — never encode a file into this call.',
    ),
  // The warning in the description is there because the failure happened. A
  // draft carrying a 204 KB PDF took 19 seconds — the bytes were pulled back
  // out of the mailbox and re-uploaded — and the client, having no result it
  // trusted, listed the drafts and then sent the identical call twice more.
  // Three drafts, all of them ours to explain. Nothing here retries, so the
  // repair is telling the caller what a slow call means and giving it
  // `drafts.list` and `drafts.delete` to act on, rather than inventing an
  // idempotency key this endpoint has nowhere to keep.
  draft_only: z
    .boolean()
    .optional()
    .describe(
      'Save as a draft instead of sending, so it can be reviewed first. This call is not idempotent and a message with an attachment can take tens of seconds, because the bytes are fetched and uploaded here: if it appears to time out, the draft may already exist. List drafts to check before calling again, and delete the surplus one rather than leaving both.',
    ),
  draft_id: z
    .string()
    .optional()
    .describe(
      'Revise this existing draft instead of writing a new one — pass the id a previous call returned. Every other argument describes the message as it should now read, because the draft is replaced rather than merged into: name the attachments again to keep them. With draft_only the revision stays a draft; without it, the revised draft is sent.',
    ),
});

/**
 * Built rather than declared, so `fetch` can be substituted in a test.
 *
 * The same seam every transport here offers. Without it a test has to reach for
 * the global, and a test that patches `globalThis` leaks into whatever runs
 * beside it.
 */
export function gmailSend(
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): ToolCapability<typeof schema> {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    kind: 'tool',
    name: 'send_message',
    description:
      'Send a message, with attachments, or save it as a draft. Attachments are named by reference — a path on this machine, an HTTPS URL, a staged handle, or another message in this mailbox — and this endpoint fetches the bytes itself, so never encode a file into the call.',
    inputSchema: schema,

    async handler(input, context): Promise<ToolResult> {
      const authorize = context.authorize;
      if (!authorize) {
        // Only reachable if this capability is ever registered on a provider with
        // no credential, which the manifest makes impossible. Stated rather than
        // asserted non-null, so the failure names its cause.
        return fail('This connection has no credential, so it cannot send.');
      }

      let attachments: ResolvedAttachment[];
      try {
        attachments = await resolveAttachments(input.attachments, {
          // Three quarters of the ceiling: attachments travel base64, so this is
          // the raw weight that fits once encoded. The composed message is measured
          // exactly below.
          maxTotalBytes: Math.floor((GMAIL_MAX_MESSAGE_BYTES * 3) / 4),
          signal: context.signal,
          mailbox: gmailAttachments({ authorize, fetch: doFetch, signal: context.signal }),
          storage: context.storage,
        });
      } catch (failure) {
        return fail((failure as Error).message);
      }

      // Normally no `From` at all: Gmail fills it from the credential, name
      // included, which is better than anything guessable here — and inventing an
      // address risks writing one this account may not send as. A name is written
      // only when someone asked for one, and then the address has to come with it,
      // since a display name alone is not a header.
      const configured = context.connection.config['from_name'];
      const fromName =
        input.from_name ??
        (typeof configured === 'string' && configured.trim() !== '' ? configured : undefined);
      const address = context.connection.displayName;

      const composed = await composeMime({
        ...(fromName && address.includes('@') ? { from: address, fromName } : {}),
        message: {
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.text,
          html: input.html,
          inReplyTo: input.in_reply_to,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });

      if (composed.raw.byteLength > GMAIL_MAX_MESSAGE_BYTES) {
        return fail(
          `The composed message is ${composed.raw.byteLength} bytes and Gmail accepts ${GMAIL_MAX_MESSAGE_BYTES}. Attachments are base64 in transit, so they weigh about a third more than on disk.`,
        );
      }

      // Recorded before submitting, so a file read off disk is in the log even if
      // the send then fails. `redact` cannot express this — it keeps an argument
      // verbatim, and `attachments` may itself hold a base64 file.
      if (attachments.length > 0) {
        context.audit.annotate({
          attachments: attachments.map((attachment) => ({
            filename: attachment.filename,
            bytes: attachment.bytes.byteLength,
            content_type: attachment.contentType,
            sha256: attachment.sha256,
            origin: attachment.origin,
          })),
        });
      }

      const drafting = input.draft_only === true;

      try {
        let sent = await submit({
          raw: composed.raw,
          draftOnly: drafting,
          draftId: input.draft_id,
          authorize,
          fetch: doFetch,
          context,
        });

        // A revision that is not staying a draft is sent by id, now that the
        // draft holds the new message. Its own failure is reported separately
        // from the update's, because the two leave the mailbox in different
        // states and only one of them is worth retrying as composed.
        if (input.draft_id !== undefined && !drafting) {
          try {
            sent = await sendDraft({
              draftId: input.draft_id,
              authorize,
              fetch: doFetch,
              context,
            });
          } catch (failure) {
            return fail(
              `The draft was revised but not sent: ${(failure as Error).message} The new message is saved as draft ${input.draft_id}, so send that rather than composing it again.`,
            );
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...(drafting
                    ? { drafted: true, draft_id: sent['id'] ?? input.draft_id ?? null }
                    : { sent: true }),
                  message_id: messageIdOf(sent) ?? composed.messageId,
                  recipients: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
                  // Names, sizes and digests, never content — see `receiptFor`.
                  ...(attachments.length > 0
                    ? { attachments: attachments.map(receiptFor) }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (failure) {
        return fail((failure as Error).message);
      }
    },
  };
}

/** The wired capability, as the provider declares it. */
export const gmailSendMessage = gmailSend();

/**
 * Hand the assembled message to Gmail.
 *
 * Two routes, chosen by size. A small message goes as base64url in a JSON field,
 * which is the ordinary endpoint and the overwhelmingly common case. A large one
 * goes to the upload host as `message/rfc822` with the raw MIME as the body —
 * `uploadType=media`, no multipart assembly, no resumable session — which is what
 * lifts the ceiling from "what fits in a JSON string" to Gmail's own 35 MiB.
 */
async function submit(input: {
  readonly raw: Uint8Array;
  readonly draftOnly: boolean;
  readonly draftId: string | undefined;
  readonly authorize: (request: Request) => Promise<Request>;
  readonly fetch: typeof globalThis.fetch;
  readonly context: ProviderContext;
}): Promise<Record<string, unknown>> {
  const { raw, draftOnly, draftId, authorize, context } = input;
  const large = raw.byteLength > GMAIL_JSON_LIMIT_BYTES;

  // Revising is a `PUT` at the draft's own address; the other two are a `POST`
  // at a collection. The upload host takes the same path either way, so size
  // still chooses the host and nothing else.
  const revising = draftId !== undefined;
  const path = revising
    ? `/drafts/${encodeURIComponent(draftId)}`
    : draftOnly
      ? '/drafts'
      : '/messages/send';
  const url = large ? `${GMAIL_UPLOAD}${path}?uploadType=media` : `${GMAIL_API}${path}`;

  const encoded = large ? undefined : Buffer.from(raw).toString('base64url');
  // A draft nests the message, whether it is being created or replaced; only a
  // straight send carries `raw` at the top level.
  const body: Uint8Array | string = large
    ? raw
    : JSON.stringify(draftOnly || revising ? { message: { raw: encoded } } : { raw: encoded });

  const request = await authorize(
    new Request(url, {
      method: revising ? 'PUT' : 'POST',
      headers: {
        'content-type': large ? 'message/rfc822' : 'application/json',
        accept: 'application/json',
      },
      body,
      ...(context.signal ? { signal: context.signal } : {}),
    }),
  );

  const response = await input.fetch(request);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Gmail refused the message with ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Send a draft that already exists, by id.
 *
 * Always small — the body is one identifier — so there is no upload-host branch
 * here even when the draft it names carries 30 MiB. The bytes were already
 * handed over by the `PUT` that preceded this.
 */
async function sendDraft(input: {
  readonly draftId: string;
  readonly authorize: (request: Request) => Promise<Request>;
  readonly fetch: typeof globalThis.fetch;
  readonly context: ProviderContext;
}): Promise<Record<string, unknown>> {
  const request = await input.authorize(
    new Request(`${GMAIL_API}/drafts/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: input.draftId }),
      ...(input.context.signal ? { signal: input.context.signal } : {}),
    }),
  );

  const response = await input.fetch(request);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Gmail refused to send the draft with ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Gmail answers with its own id; a draft nests the message inside. */
function messageIdOf(body: Record<string, unknown>): string | null {
  const id = body['id'];
  if (typeof id === 'string' && !('message' in body)) return id;

  const message = body['message'];
  if (message !== null && typeof message === 'object') {
    const nested = (message as { id?: unknown }).id;
    if (typeof nested === 'string') return nested;
  }

  return typeof id === 'string' ? id : null;
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
