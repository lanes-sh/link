import { z } from 'zod';
import {
  attachmentRefSchema,
  guessContentType,
  receiptFor,
  resolveAttachments,
} from '#connectivity/mail';
import { defineLocalProvider, keepKeys, type ProviderDefinition } from '#connectivity';
import {
  allAssets,
  assertAssetName,
  describeAsset,
  digestOf,
  findAsset,
  humanBytes,
  isTextual,
} from './store.ts';

/**
 * `assets` — files the owner wants kept.
 *
 * **This exists because memory holds Markdown.** A PDF, an image, an export had
 * nowhere to live except the owner's own filesystem — which a deployed endpoint
 * cannot reach at all, so on any target but `local` the answer was that there
 * was no answer. An asset is a file in the profile's own store, named, listed,
 * and served from wherever that profile runs. ADR-051.
 *
 * **Bytes never pass through the model, in either direction.** A write names one
 * of the five sources `#connectivity/mail` already resolves — a path on the
 * endpoint's machine, an HTTPS URL, a staged handle, an attachment on a message,
 * or inline base64 as the last resort — and the endpoint reads them itself. That
 * is not a new rule: it is ADR-017's, reused rather than restated, which also
 * buys the size ceiling, the refusal when two sources are named, and the
 * SHA-256 receipt that makes "what exactly was stored" answerable.
 *
 * A read is the same rule the other way. `ResourceContents` carries text and
 * nothing else (`#connectivity`'s `capability.ts`), so a text asset comes back
 * as text and a binary one comes back *described* — name, type, size, digest.
 * A 239 KB PDF is roughly 320,000 characters of base64, and handing that to a
 * model is the cost the five sources exist to avoid; there is no reason to pay
 * it on the way in that would not also apply on the way out.
 *
 * **Neither direction between a mailbox and this store is done here**, and that
 * is a boundary rather than a gap. It cost somebody a real attempt: `store` takes
 * the shared attachment shape, which advertises `message_id`, so an agent asked to
 * keep a PDF that had arrived by mail read the description, named the message, and
 * was refused — twice, having tried the obvious workaround in between. The schema
 * offered a route the handler never had. The description above now says so, and
 * the refusal in `#connectivity/mail` names what does work instead.
 *
 * The reason it cannot is real rather than incidental. A staged handle is scoped to `<provider>/<connection>`
 * (`#dispatch`'s `stageAttachment`), so a handle minted under `assets/main` is
 * deliberately unresolvable from `gmail/main` — bridging the two means crossing
 * the isolation every provider relies on, and that belongs in dispatch if it
 * belongs anywhere. `lanes link attach <file> --connection <provider>.<account>`
 * already prints a handle the mail tools accept.
 */

const DEFAULT_LIMIT = 30;

/**
 * The ceiling on one stored asset.
 *
 * Not a vendor limit — there is no vendor. It bounds what a `url` source can
 * pull into the endpoint's memory in one call, which is the only place an
 * unbounded read could come from, and it is sized so an ordinary document,
 * spreadsheet, or photograph goes through and a video does not.
 */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** How much text a read will return before it describes the file instead. */
const MAX_TEXT_BYTES = 256 * 1024;

export const assetsProvider: ProviderDefinition = defineLocalProvider({
  id: 'lanes_assets',
  name: 'Assets',
  version: '1.0.0',
  description:
    "Files the owner wants kept, addressed by filename. Storing one names a source — a path, a URL, a staged handle — and the endpoint reads the bytes; they are never encoded into a call. Writing is a separate capability from reading.",

  configSchema: z.object({}),
  connectionSchema: z.object({}),

  bundles: [
    {
      name: 'read',
      description: 'List and read stored files.',
      oauth_scopes: [],
      capabilities: ['file', 'list', 'get'],
      default: true,
    },
    {
      name: 'write',
      description: 'Store and delete files.',
      oauth_scopes: [],
      capabilities: ['store', 'remove'],
    },
  ],

  capabilities: [
    {
      kind: 'resource',
      name: 'file',
      title: 'Stored file',
      description:
        'One stored file, addressed by its name. Text comes back as text; anything else is described rather than encoded.',
      uriTemplate: 'lanes-assets://file/{name}',
      redact: keepKeys('uri'),

      async list(context) {
        return (await allAssets(context.storage)).map((asset) => ({
          uri: `lanes-assets://file/${encodeURIComponent(asset.name)}`,
          name: asset.name,
        }));
      },

      async read(uri, params, context) {
        const raw = params['name'];
        if (!raw) throw new Error(`Malformed asset URI: ${uri}`);

        const name = decodeURIComponent(raw);
        const asset = await findAsset(context.storage, name);
        if (asset === null) throw new Error(`No asset "${name}" on ${context.connection.key}`);

        const bytes = await context.storage.get(name);
        if (bytes === null) throw new Error(`No asset "${name}" on ${context.connection.key}`);

        return textOrSummary(uri, name, asset.contentType, bytes);
      },
    },

    {
      kind: 'tool',
      name: 'list',
      title: 'List stored files',
      description:
        'Every file kept in this profile, newest first, with its type and size. This is the whole index — an asset carries no description, so what a file is for belongs in memory.',
      inputSchema: z.object({
        query: z.string().optional().describe('Restrict to names containing this text'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Maximum results (default ${DEFAULT_LIMIT})`),
      }),
      // Nothing kept: a filename is the owner's own material, the same call
      // `memory.search` makes about a query.
      async handler({ query, limit }, context) {
        const needle = query?.toLowerCase();
        const all = await allAssets(context.storage);
        const found = needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all;
        const shown = found.slice(0, limit ?? DEFAULT_LIMIT);

        context.audit.annotate({ scanned: all.length, matched: found.length });

        if (shown.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No ${needle ? 'matching ' : ''}assets on ${context.connection.key}.`,
              },
            ],
          };
        }

        return {
          content: [
            ...shown.flatMap((asset) => [
              {
                type: 'resource_link' as const,
                uri: `lanes-assets://file/${encodeURIComponent(asset.name)}`,
                name: asset.name,
              },
              { type: 'text' as const, text: describeAsset(asset) },
            ]),
            ...(found.length > shown.length
              ? [
                  {
                    type: 'text' as const,
                    text: `… ${found.length - shown.length} more. Raise limit, or narrow with query.`,
                  },
                ]
              : []),
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'get',
      title: 'Read a stored file',
      description:
        'Return a text file\'s contents. A binary file is described instead — name, type, size, digest — because encoding it here is the cost this provider exists to avoid. The resource lanes-assets://file/{name} is the same content.',
      inputSchema: z.object({ name: z.string().min(1).describe('The file name') }),
      redact: keepKeys('name'),
      async handler({ name }, context) {
        const asset = await findAsset(context.storage, name);
        const bytes = asset === null ? null : await context.storage.get(name);

        if (asset === null || bytes === null) {
          return {
            content: [{ type: 'text', text: `No asset "${name}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        const { text } = textOrSummary('', name, asset.contentType, bytes);
        return { content: [{ type: 'text', text }] };
      },
    },

    {
      kind: 'tool',
      name: 'store',
      title: 'Store a file',
      description:
        'Keep a file in this profile. Name exactly one source — path, url, handle, or data — and the endpoint reads the bytes itself; never base64 a file into this call when any other source will do. Storing under a name that exists replaces it. An attachment sitting in a mailbox cannot be named here: this connection holds no mailbox, so ask the mail connection to send it somewhere it can be reached from.',
      inputSchema: z.object({
        source: attachmentRefSchema.describe(
          'Where the bytes come from. Exactly one of path, url, handle, or data. The mailbox sources — message_id and uid — are part of the shared shape but cannot resolve here.',
        ),
        name: z
          .string()
          .optional()
          .describe('What to call it. Taken from the source when omitted.'),
      }),
      // The name and the source shape are the record of what happened; the bytes
      // are the content. `annotate` below adds the resolved facts, which is the
      // half that makes a write log worth reading — see ADR-017.
      redact: keepKeys('name'),
      async handler({ source, name }, context) {
        const [resolved] = await resolveAttachments([source], {
          maxTotalBytes: MAX_ASSET_BYTES,
          storage: context.storage,
          signal: context.signal,
        });

        if (!resolved) throw new Error('source named no file.');

        const assetName = name ?? resolved.filename;
        assertAssetName(assetName);

        // Renaming can improve the type. `resolveAttachments` guesses from the
        // *source's* filename, so storing a URL that ended `/download` as
        // `report.csv` arrives as octet-stream; the name the owner chose is the
        // better evidence, but only where the source had none to offer.
        const contentType =
          name && resolved.contentType === 'application/octet-stream'
            ? guessContentType(assetName)
            : resolved.contentType;
        const replaced = await context.storage.has(assetName);

        await context.storage.put(assetName, resolved.bytes, { contentType });

        // The resolved facts rather than the argument: `source` may literally be
        // a file, so keeping it verbatim would put base64 in the log. This is
        // the same annotation `gmail.send_message` records.
        context.audit.annotate({ asset: assetName, replaced, ...receiptFor(resolved), origin: resolved.origin });

        return {
          content: [
            {
              type: 'text',
              text:
                `${replaced ? 'Replaced' : 'Stored'} "${assetName}" on ${context.connection.key} — ` +
                `${contentType}, ${humanBytes(resolved.bytes.byteLength)}, sha256 ${resolved.sha256.slice(0, 12)}…`,
            },
            {
              type: 'resource_link',
              uri: `lanes-assets://file/${encodeURIComponent(assetName)}`,
              name: assetName,
            },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'remove',
      title: 'Delete a stored file',
      description: 'Remove a file and its bytes. There is no trash.',
      inputSchema: z.object({ name: z.string().min(1).describe('The file name') }),
      redact: keepKeys('name'),
      async handler({ name }, context) {
        assertAssetName(name);

        const existed = await context.storage.has(name);
        await context.storage.delete(name);

        return {
          content: [
            {
              type: 'text',
              text: existed
                ? `Deleted "${name}" from ${context.connection.key}.`
                : `No asset "${name}" on ${context.connection.key}.`,
            },
          ],
          ...(existed ? {} : { isError: true }),
        };
      },
    },
  ],
});

/**
 * Text if it can be, a description if it cannot.
 *
 * One function for both the tool and the resource, so the two cannot come to
 * different conclusions about the same file — which is the failure that would
 * make "read it as a resource instead" a workaround for a refusal.
 */
function textOrSummary(
  uri: string,
  name: string,
  contentType: string,
  bytes: Uint8Array,
): { uri: string; mimeType: string; text: string } {
  if (isTextual(contentType, bytes) && bytes.byteLength <= MAX_TEXT_BYTES) {
    return { uri, mimeType: contentType, text: new TextDecoder().decode(bytes) };
  }

  const why =
    bytes.byteLength > MAX_TEXT_BYTES
      ? `larger than the ${humanBytes(MAX_TEXT_BYTES)} a read returns`
      : 'not text';

  return {
    uri,
    mimeType: 'text/plain',
    text:
      `${name} — ${contentType}, ${humanBytes(bytes.byteLength)}, sha256 ${digestOf(bytes)}.\n` +
      `Its contents are ${why}, so they are not returned. ` +
      'To attach it to something, ask the owner for a handle: ' +
      'lanes link attach <file> --connection <provider>.<account>',
  };
}

export default assetsProvider;
