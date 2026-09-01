import { z } from 'zod';
import { splitOptionalFrontmatter, stringList, withFrontmatter } from '#providers/shared/frontmatter.ts';
import { slugify as slugifyText } from '#providers/shared/slug.ts';
import {
  defineLocalProvider,
  keepKeys,
  type BlobStore,
  type ProviderDefinition,
} from '#connectivity';

/**
 * `memory` — the owner's accumulated knowledge.
 *
 * **Reading and writing are separate capabilities**, and that separation is the
 * whole security argument for this provider (ADR-012 §2, `https://lanes.sh/docs/link/security`).
 * Upstream content is already treated as potentially prompt-injecting and passed
 * through unscreened; memory an agent can *write to* changes the shape of that
 * risk rather than its size, because an injected instruction is stored once and
 * re-served to every future session, including to a different agent. A read-only
 * memory cannot do that. Nothing here screens what is written — this separates
 * the privilege, and makes no claim to detect anything.
 *
 * **One entry is one Markdown file.** Title, tags, and timestamp are YAML
 * frontmatter above the body, in the same format a skill uses, and the whole
 * thing is a single `BlobStore` object — locally a file under the profile's
 * storage directory, in a deployment an S3 object. There is no index row.
 *
 * That is a deliberate reversal of the original split (ADR-014). An index in
 * `ScopedStore` beside a body in `BlobStore` made listing cheap, and cost more
 * than it bought: the two could disagree, the entry could not be opened in an
 * editor, and a hand-written file was not an entry at all. `lanes link memory` and a
 * text editor now reach the same bytes, which is the point of the format.
 *
 * The store is namespaced `<provider>/<connection>` by core before this
 * provider sees it, so one connection's memory is not addressable from another.
 */

const DEFAULT_LIMIT = 10;
/**
 * No key prefix.
 *
 * There was an `entry/` one, which put a third segment under a path that was
 * already `<provider>/<connection>` — an entry landed at
 * `memory/memory/entry/<id>.md`. The namespace is the isolation boundary and it
 * is already applied by the time a key reaches here, so the prefix only ever
 * separated entries from other things this provider does not store.
 */
const ENTRY_PREFIX = '';

/** An entry's frontmatter, parsed. Every field has a fallback — see `readEntry`. */
interface Entry {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
  readonly body: string;
  readonly bytes: number;
}

const ENTRY_ID = /^[a-z0-9][a-z0-9_-]*$/;

function entryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}.md`;
}

function idFromKey(key: string): string | null {
  if (!key.startsWith(ENTRY_PREFIX) || !key.endsWith('.md')) return null;
  const id = key.slice(ENTRY_PREFIX.length, -'.md'.length);
  return ENTRY_ID.test(id) ? id : null;
}

/**
 * Parse one stored entry.
 *
 * Frontmatter is optional, and its absence is not an error: these files are in
 * a directory the owner may edit, and a plain Markdown file dropped in there
 * should read as an entry titled after its id rather than break the listing
 * that would have shown it. `lanes link memory write` puts the frontmatter back.
 */
function parseEntry(id: string, text: string, fallbackUpdatedAt: string): Entry {
  const { frontmatter, body } = splitOptionalFrontmatter(text);
  const title = frontmatter['title'];
  const updatedAt = frontmatter['updated_at'];

  return {
    id,
    title: typeof title === 'string' && title.trim().length > 0 ? title : id,
    tags: stringList(frontmatter['tags']),
    updatedAt: typeof updatedAt === 'string' ? updatedAt : fallbackUpdatedAt,
    body: body.trimEnd(),
    bytes: new TextEncoder().encode(text).byteLength,
  };
}

function serialiseEntry(entry: {
  title: string;
  tags: readonly string[];
  updatedAt: string;
  body: string;
}): string {
  return withFrontmatter(
    {
      title: entry.title,
      ...(entry.tags.length > 0 ? { tags: [...entry.tags] } : {}),
      updated_at: entry.updatedAt,
    },
    `${entry.body.trimEnd()}\n`,
  );
}

async function readEntry(storage: BlobStore, id: string): Promise<Entry | null> {
  const bytes = await storage.get(entryKey(id));
  if (bytes === null) return null;

  return parseEntry(id, new TextDecoder().decode(bytes), new Date(0).toISOString());
}

/**
 * How many entries are read at once.
 *
 * A bound rather than `Promise.all` over the whole listing: against a bucket
 * each read is an HTTPS request, and firing four hundred at once trades a slow
 * search for a rate-limited one. Against a local directory the cap costs
 * nothing measurable.
 */
const READ_CONCURRENCY = 16;

/**
 * Every entry, newest first.
 *
 * **This reads every entry, and is honest about being one pass over all of
 * them.** That is the cost of one file per entry: the metadata a listing needs
 * is inside the document, so there is nothing cheaper to consult. At owner
 * scale — hundreds of entries, one process, a local directory — it is fine, and
 * the previous index row bought its speed by being a second copy that could
 * disagree with the file it described.
 *
 * The reads are concurrent, which is not a micro-optimisation: one pass over
 * four hundred entries is four hundred serial round trips once the store is a
 * bucket rather than a directory, and serial round trips are the whole of the
 * difference between a search that feels instant and one that times out.
 *
 * If this ever has to serve tens of thousands of entries, the fix is a derived
 * cache that can be rebuilt from the files, never a second source of truth.
 */
async function allEntries(storage: BlobStore): Promise<Entry[]> {
  const blobs = (await storage.list(ENTRY_PREFIX)).flatMap((blob) => {
    const id = idFromKey(blob.key);
    return id === null ? [] : [{ blob, id }];
  });

  const entries: Entry[] = [];

  for (let start = 0; start < blobs.length; start += READ_CONCURRENCY) {
    const batch = await Promise.all(
      blobs.slice(start, start + READ_CONCURRENCY).map(async ({ blob, id }) => {
        const bytes = await storage.get(blob.key);
        return bytes === null
          ? null
          : parseEntry(id, new TextDecoder().decode(bytes), blob.modifiedAt.toISOString());
      }),
    );
    for (const entry of batch) if (entry) entries.push(entry);
  }

  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A stable id from a title, so writing does not demand one be invented. */
function slugify(title: string): string {
  return slugifyText(title, 'entry');
}

export const memoryProvider: ProviderDefinition = defineLocalProvider({
  id: 'memory',
  name: 'Memory',
  version: '1.0.0',
  description:
    "The owner's accumulated knowledge. Entries are addressed by id as resources and found by content with memory.search. Writing is a separate capability from reading.",

  configSchema: z.object({}),
  connectionSchema: z.object({}),

  bundles: [
    {
      name: 'read',
      description: 'Retrieve and search entries.',
      oauth_scopes: [],
      capabilities: ['entry', 'search', 'get'],
      default: true,
    },
    {
      // Not in the default bundle, and worth denying explicitly for any agent
      // that does not need it — see the provider docstring.
      name: 'write',
      description: 'Create, replace, and delete entries.',
      oauth_scopes: [],
      capabilities: ['write', 'forget'],
    },
  ],

  capabilities: [
    /**
     * Retrieval by address — a resource, not a tool (ADR-006).
     *
     * A memory entry is read-oriented context with a stable identifier, which is
     * the definition of the primitive. It is the case ADR-006 said the
     * distinction would matter for.
     */
    {
      kind: 'resource',
      name: 'entry',
      title: 'Memory entry',
      description: 'One stored memory entry, addressed by its id.',
      uriTemplate: 'memory://entry/{id}',
      mimeType: 'text/markdown',
      // The address is worth recording and the content is not — the same trade
      // `gmail.get_message` makes with a message id.
      redact: keepKeys('uri'),

      async list(context) {
        return (await allEntries(context.storage)).map((entry) => ({
          uri: `memory://entry/${encodeURIComponent(entry.id)}`,
          name: entry.title,
        }));
      },

      async read(uri, params, context) {
        const raw = params['id'];
        if (!raw) throw new Error(`Malformed memory URI: ${uri}`);

        const id = decodeURIComponent(raw);
        const entry = await readEntry(context.storage, id);
        if (entry === null) throw new Error(`No memory entry "${id}" on ${context.connection.key}`);

        return { uri, mimeType: 'text/markdown', text: entry.body };
      },
    },

    {
      kind: 'tool',
      name: 'get',
      title: 'Read a memory entry',
      description:
        'Return one entry by id. The resource memory://entry/{id} is the same content; this exists for clients that do not read resources.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Entry id'),
      }),
      redact: keepKeys('id'),
      async handler({ id }, context) {
        const entry = await readEntry(context.storage, id);

        if (entry === null) {
          return {
            content: [{ type: 'text', text: `No memory entry "${id}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        return { content: [{ type: 'text', text: entry.body }] };
      },
    },

    {
      kind: 'tool',
      name: 'search',
      title: 'Search memory',
      description:
        'Find entries whose title, tags, or body contain the query. Case-insensitive substring matching, not ranked relevance.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Text to look for'),
        tag: z.string().optional().describe('Restrict to entries carrying this tag'),
        limit: z.number().int().min(1).max(50).optional().describe(`Maximum results (default ${DEFAULT_LIMIT})`),
      }),
      // Kept, and this reverses the rule the rest of this file follows.
      //
      // The old comment here read "a memory query is as revealing as a Gmail
      // search query, and frequently more so", which is true and is an argument
      // about the wrong thing. A search term is not the owner's material: it is
      // what an *agent* went looking for in that material, which is precisely
      // the question this log exists to answer. Withholding it leaves a record
      // saying memory was searched, twice, and matched nothing, with no way to
      // tell a calendar lookup from a rummage through someone's medical notes.
      //
      // The body stays withheld either way — `entry` and `get` keep only `uri`
      // and `id`, so what was *found* is still not in here. This records the
      // question, not the answer.
      //
      // The reason for the old rule was `audit/fanout.ts`: a workspace may ship
      // copies to stdout or an OTLP collector, and those leave the machine. That
      // is a real exposure and it is the operator's to weigh, which is what a
      // declared sink is. It is not a reason to withhold from the durable log on
      // the operator's own disk.
      redact: keepKeys('query', 'tag', 'limit'),
      async handler({ query, tag, limit }, context) {
        const needle = query.toLowerCase();
        const entries = await allEntries(context.storage);
        const candidates = tag ? entries.filter((entry) => entry.tags.includes(tag)) : entries;

        const matches: Array<{ entry: Entry; snippet: string }> = [];

        for (const entry of candidates) {
          if (matches.length >= (limit ?? DEFAULT_LIMIT)) break;

          const inHeader =
            entry.title.toLowerCase().includes(needle) ||
            entry.tags.some((value) => value.toLowerCase().includes(needle));

          const at = entry.body.toLowerCase().indexOf(needle);
          if (!inHeader && at === -1) continue;

          matches.push({ entry, snippet: at === -1 ? entry.title : excerpt(entry.body, at) });
        }

        context.audit.annotate({ scanned: candidates.length, matched: matches.length });

        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `No memory entry matches on ${context.connection.key}.` }] };
        }

        // A `resource_link` rather than a URI spelled into the text: core routes
        // the link to the profile and connection this call was made on, and a
        // provider must not learn either. Written as text it would name an
        // address no client could read.
        return {
          content: matches.flatMap(({ entry, snippet }) => [
            {
              type: 'resource_link' as const,
              uri: `memory://entry/${encodeURIComponent(entry.id)}`,
              name: entry.title,
            },
            {
              type: 'text' as const,
              text: `${entry.title}${entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''}\n${snippet}`,
            },
          ]),
        };
      },
    },

    {
      kind: 'tool',
      name: 'write',
      title: 'Store a memory entry',
      description:
        'Create or replace an entry. Deliberately a separate capability from reading: an instruction written here is served to every later session, so an agent that only needs to recall should not be granted this.',
      inputSchema: z.object({
        title: z.string().min(1).describe('Short human-readable title'),
        text: z.string().min(1).describe('The entry body, as Markdown'),
        id: z.string().optional().describe('Entry id. Derived from the title when omitted; naming an existing one replaces it.'),
        tags: z.array(z.string()).optional().describe('Labels for filtering searches'),
      }),
      // The title and the id are addresses; the text is the content itself.
      redact: keepKeys('id', 'title', 'tags'),
      async handler({ title, text, id, tags }, context) {
        const entryId = id ?? slugify(title);
        assertEntryId(entryId);

        const document = serialiseEntry({
          title,
          tags: tags ?? [],
          updatedAt: new Date().toISOString(),
          body: text,
        });
        const bytes = new TextEncoder().encode(document);
        await context.storage.put(entryKey(entryId), bytes, { contentType: 'text/markdown' });

        context.audit.annotate({ entry: entryId, bytes: bytes.byteLength });

        return {
          content: [
            { type: 'text', text: `Stored memory entry "${entryId}" on ${context.connection.key}.` },
            { type: 'resource_link', uri: `memory://entry/${entryId}`, name: title },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'forget',
      title: 'Delete a memory entry',
      description: 'Remove an entry and its body.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Entry id'),
      }),
      redact: keepKeys('id'),
      async handler({ id }, context) {
        const existed = await context.storage.has(entryKey(id));
        await context.storage.delete(entryKey(id));

        return {
          content: [
            {
              type: 'text',
              text: existed
                ? `Forgot memory entry "${id}" on ${context.connection.key}.`
                : `No memory entry "${id}" on ${context.connection.key}.`,
            },
          ],
          ...(existed ? {} : { isError: true }),
        };
      },
    },
  ],
});

export function assertEntryId(id: string): void {
  if (!ENTRY_ID.test(id)) {
    throw new Error(
      `Memory entry id ${JSON.stringify(id)} must be lowercase letters, digits, "_" or "-".`,
    );
  }
}

/** A window around a match, so a result says why it matched. */
function excerpt(body: string, at: number, width = 160): string {
  const start = Math.max(0, at - width / 4);
  const text = body.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${start + width < body.length ? '…' : ''}`;
}

export default memoryProvider;

/**
 * The pieces `lanes link memory` needs to reach the same bytes this provider does.
 *
 * Exported rather than reimplemented in the CLI: two spellings of one storage
 * layout is exactly how a control plane and its data plane drift apart.
 */
export const memoryStorage = {
  key: entryKey,
  idFromKey,
  parse: parseEntry,
  serialise: serialiseEntry,
  read: readEntry,
  all: allEntries,
  prefix: ENTRY_PREFIX,
  slugify,
};

export type MemoryEntry = Entry;
