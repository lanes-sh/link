import { z } from 'zod';
import { attachmentRefSchema, receiptFor, resolveAttachments } from '#connectivity/mail';
import { keepKeys, type ProviderContext, type ToolCapability, type ToolResult } from '#connectivity';

/**
 * Holding a file for a later call.
 *
 * The gap this closes is specific. Every other attachment source names bytes the
 * *endpoint* can already reach — a path on its disk, a URL it can fetch, a
 * message in a mailbox it holds. A client with a file only it can see has none
 * of them, and MCP offers no other channel: there is no client-to-server binary
 * transfer in the protocol, and a tool argument is the only thing that travels.
 * So the bytes do have to cross as base64 once. What was missing was somewhere
 * for them to land, so that "once" was not "on every send".
 *
 * That is the whole design. `store` keeps a file by name because the owner wants
 * it kept; this keeps one for a day because a call is about to name it, and the
 * two are different questions. Putting a chat's scratch PDF into the owner's
 * named files to send an email would answer the second by corrupting the first.
 *
 * The handle is profile-level, not connection-level, which is the point — it is
 * staged here and named by a mail connection. `#dispatch` binds that crossing
 * (`ProviderContext.attachments`) and is where the argument for its safety
 * lives: only bytes the caller supplied, or bytes the profile already owns,
 * ever reach the shared area.
 */

const schema = z.object({
  source: attachmentRefSchema.describe(
    'Where the bytes come from. Use data for a file only you have; url for one this endpoint can fetch.',
  ),
  filename: z.string().optional().describe('What to call it. Taken from the source when omitted.'),
  content_type: z.string().optional().describe('Overrides the type derived from the source.'),
});

/** Raw bytes a caller may hand over in one call. The same ceiling `store` uses. */
const MAX_STAGED_BYTES = 25 * 1024 * 1024;

export function stageCapability(): ToolCapability<typeof schema> {
  return {
    kind: 'tool',
    name: 'stage',
    title: 'Hold a file for a later call',
    description:
      'Hold a file for a later call, anywhere in this profile. Name one source — data for a file ' +
      'only you have, url for one this endpoint can fetch — and get back a handle, a digest and an ' +
      'expiry, not the bytes. That handle names the file in any send from this profile, from any ' +
      'connection, for 24 hours. Use it once rather than encoding the same file into every call; ' +
      'use store instead to keep the file by name.',
    inputSchema: schema,
    // Never `source`, which may literally be a base64 file. The annotation below
    // carries the resolved facts instead — the same trade `store` makes.
    redact: keepKeys('filename', 'content_type'),
    async handler(input, context: ProviderContext): Promise<ToolResult> {
      if (!context.attachments) {
        return {
          content: [
            {
              type: 'text',
              text: 'This endpoint cannot hold a file for later, so name the file directly in the call that needs it.',
            },
          ],
          isError: true,
        };
      }

      // Folded into the source rather than applied to the result. `filename` and
      // `content_type` are siblings of `source` because that reads better than
      // burying them inside it, but the resolver is where a name turns into a
      // type — overriding afterwards left a `.txt` as octet-stream, because the
      // type had already been guessed from a name the resolver never saw.
      const source = {
        ...input.source,
        ...(input.filename ? { filename: input.filename } : {}),
        ...(input.content_type ? { content_type: input.content_type } : {}),
      };

      const [resolved] = await resolveAttachments([source], {
        maxTotalBytes: MAX_STAGED_BYTES,
        storage: context.storage,
        shared: context.attachments,
        signal: context.signal,
      });
      if (!resolved) throw new Error('source named no file.');

      const { filename, contentType } = resolved;

      const receipt = await context.attachments.stage({
        bytes: resolved.bytes,
        filename,
        contentType,
      });

      // `origin` is the fact that matters here and is not in `receiptFor`: it
      // separates a file the caller handed over from one read off the endpoint's
      // own disk, which is what makes "what entered this endpoint" answerable.
      context.audit.annotate({
        handle: receipt.handle,
        ...receiptFor(resolved),
        origin: resolved.origin,
        expires_at: new Date(receipt.expiresAt).toISOString(),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                handle: receipt.handle,
                filename,
                content_type: contentType,
                bytes: resolved.bytes.byteLength,
                // The digest the resolver computed over the bytes it read, not
                // the one the staging area reports back. One fact, one source.
                sha256: resolved.sha256,
                expires_at: new Date(receipt.expiresAt).toISOString(),
                hint: 'Name this handle as an attachment, or store it under a name to keep it.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
