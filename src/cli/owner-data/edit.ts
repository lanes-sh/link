import { ConfigError } from '#profile';
import { openCatalogue } from '#providers/entities/catalogue.ts';
import { forgetEntity, persistEntity } from '#providers/entities/writes.ts';
import { readSkill, removeSkill, writeSkill } from '#providers/skills/store.ts';
import { assetStorage, entityStorage, memoryStorage, taskStorage } from '#providers/owner.ts';
import type { BlobStore } from '#stores/blobs';
import type { Runtime } from '../runtime.ts';
import { recordDataChange, type DataCapability } from '../audit-change.ts';
import { readItem } from './browse.ts';
import { storeFor } from './stores.ts';
import {
  answered,
  DASHBOARD_PRINCIPAL,
  refused,
  type Answer,
  type DataDetail,
  type DataStoreName,
} from './surface.ts';

/**
 * Writing the five stores a pairing token may write (ADR-069).
 *
 * **A write is the document, parsed by the module that owns the format and
 * written back through it.** Not a passthrough `put`: an entity written without
 * maintaining `_index.json` leaves every later read rebuilding it, and a skill
 * whose frontmatter does not parse is a capability that disappears from the
 * registry at the next reload. Both of those fail silently, which is why the
 * parse happens here rather than being trusted to the caller.
 *
 * **An id is derived, never invented by the caller.** Every Markdown store
 * slugifies from the title, and skills refuse a name needing a slug rather than
 * renaming one silently — a renamed skill is a policy rule that stops matching.
 * So `create` reads the id out of the document it was handed and answers with
 * what it actually wrote.
 *
 * **Every write is recorded before it is answered.** `recordDataChange` writes
 * the capability an agent would have used, so one search over the log finds
 * both. Identifiers are kept, the document is not.
 */

const now = (): string => new Date().toISOString();

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * The capability a store's write and removal are recorded under.
 *
 * The names an agent's call carries, so a row written from a browser and a row
 * written over MCP sort together rather than needing two vocabularies.
 */
const WROTE: Record<Exclude<DataStoreName, 'vault'>, DataCapability> = {
  memory: 'memory.write',
  tasks: 'tasks.add',
  assets: 'assets.store',
  skills: 'skills.manage.write',
  entities: 'entities.write',
};

const REMOVED: Record<Exclude<DataStoreName, 'vault'>, DataCapability> = {
  memory: 'memory.forget',
  tasks: 'tasks.remove',
  assets: 'assets.remove',
  skills: 'skills.manage.remove',
  entities: 'entities.forget',
};

/**
 * The id a document is about to be stored under.
 *
 * Read out of the document by the store's own parser, so a title becomes the
 * same id it would have become through the CLI or over MCP. `null` where the
 * document carries nothing to derive one from, which is a `400` rather than a
 * generated name nobody asked for.
 */
function idFromDocument(store: DataStoreName, body: string): string | null {
  const { frontmatter } = splitTitle(body);
  const title = frontmatter ?? '';
  if (title.trim().length === 0) return null;

  const slug =
    store === 'tasks'
      ? taskStorage.slugify(title)
      : store === 'entities'
        ? entityStorage.slugify(title)
        : memoryStorage.slugify(title);

  return slug.length > 0 ? slug : null;
}

/**
 * The `title:` or `name:` line, without parsing the whole document.
 *
 * A create has to know the id before it can validate the document against the
 * store, and every store's parser wants an id to parse *with* — so this reads
 * the one line it needs. Deliberately shallow: the real parse happens below and
 * is what decides whether the write is accepted.
 */
function splitTitle(body: string): { frontmatter: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!match) return { frontmatter: null };

  const line = /^(?:title|name):\s*(.+)$/m.exec(match[1] ?? '');
  const value = line?.[1]?.trim() ?? '';
  return { frontmatter: value.replace(/^["']|["']$/g, '') };
}

export async function writeItem(
  runtime: Runtime,
  store: DataStoreName,
  id: string,
  body: string,
): Promise<Answer<DataDetail>> {
  if (store === 'vault') return notWritable();

  const scoped = storeFor(runtime, store);
  if (!scoped.ok) return scoped;

  const existed = await exists(scoped.value.store, store, id);
  const accepted = await persist(scoped.value.store, store, id, body);
  if (!accepted.ok) return accepted;

  await recordDataChange(runtime, DASHBOARD_PRINCIPAL, {
    capability: WROTE[store],
    connection: scoped.value.connection,
    provider: scoped.value.provider,
    // Identifiers and shape, never the document. The house rule for a write
    // log: it must record that something changed and what, without becoming a
    // second copy of the thing that changed.
    arguments: { id, store, bytes: encode(body).byteLength, replaced: existed },
  });

  return readItem(runtime, store, id);
}

export async function createItem(
  runtime: Runtime,
  store: DataStoreName,
  body: string,
): Promise<Answer<DataDetail>> {
  if (store === 'vault') return notWritable();

  const id = idFromDocument(store, body);
  if (id === null) {
    return refused(
      400,
      'no_title',
      'A new item needs frontmatter carrying a title, which is what its id is derived from.',
    );
  }

  return writeItem(runtime, store, id, body);
}

export async function removeItem(
  runtime: Runtime,
  store: DataStoreName,
  id: string,
): Promise<Answer<void>> {
  if (store === 'vault') return notWritable();

  const scoped = storeFor(runtime, store);
  if (!scoped.ok) return scoped;

  const blobs = scoped.value.store;

  if (store === 'entities') {
    const catalogue = await openCatalogue(blobs);
    if (!catalogue.entities.some((one) => one.id === id)) return missing(store, id);
    await forgetEntity(blobs, catalogue, id, now());
  } else if (store === 'skills') {
    if (!(await removeSkill(blobs, id))) return missing(store, id);
  } else {
    const key = keyFor(store, id);
    if (!(await blobs.has(key))) return missing(store, id);
    await blobs.delete(key);
  }

  await recordDataChange(runtime, DASHBOARD_PRINCIPAL, {
    capability: REMOVED[store],
    connection: scoped.value.connection,
    provider: scoped.value.provider,
    arguments: { id, store },
  });

  return answered(undefined);
}

/**
 * Put one document on the store, through whatever owns its format.
 *
 * Each branch validates by parsing and refuses with the message the parser
 * wrote. A `400` here is the one refusal on this surface a reader is shown
 * verbatim: "not paired" for a skill with a bad `description:` would send
 * somebody to re-run a pairing command that was never the problem.
 */
async function persist(
  blobs: BlobStore,
  store: DataStoreName,
  id: string,
  body: string,
): Promise<Answer<void>> {
  try {
    switch (store) {
      case 'memory': {
        // Parsed to prove it reads back as the entry a listing will show, then
        // stored as written. Frontmatter is optional here by design, so a
        // document without any is an entry titled after its id, not an error.
        memoryStorage.parse(id, body, now());
        await blobs.put(memoryStorage.key(id), encode(body), { contentType: 'text/markdown' });
        return answered(undefined);
      }
      case 'tasks': {
        taskStorage.parse(id, body, now());
        await blobs.put(taskStorage.key(id), encode(body), { contentType: 'text/markdown' });
        return answered(undefined);
      }
      case 'entities': {
        const entity = entityStorage.parse(id, body, now());
        // Through `persistEntity`, never `writeEntity`: it is what keeps
        // `_index.json` describing the store it sits in.
        await persistEntity(blobs, entity);
        return answered(undefined);
      }
      case 'skills': {
        // `writeSkill` parses before it persists and rewrites an existing skill
        // in whatever layout it already has, so nothing here decides between
        // `<name>.md` and `<name>/SKILL.md`.
        await writeSkill(blobs, id, body);
        return answered(undefined);
      }
      case 'assets': {
        assetStorage.assertName(id);
        await blobs.put(id, encode(body), { contentType: 'text/plain; charset=utf-8' });
        return answered(undefined);
      }
      default:
        return notWritable();
    }
  } catch (error) {
    return refused(400, 'rejected', message(error));
  }
}

function keyFor(store: DataStoreName, id: string): string {
  switch (store) {
    case 'memory':
      return memoryStorage.key(id);
    case 'tasks':
      return taskStorage.key(id);
    case 'entities':
      return entityStorage.key(id);
    default:
      return id;
  }
}

async function exists(blobs: BlobStore, store: DataStoreName, id: string): Promise<boolean> {
  if (store === 'skills') return (await readSkill(blobs, id).catch(() => null)) !== null;
  return blobs.has(keyFor(store, id));
}

function notWritable<T>(): Answer<T> {
  // The same answer an unroutable path gets. A distinguishable refusal would
  // confirm the shape of what is here to a page that is not the dashboard.
  return refused(404, 'not_found', 'Not found.');
}

function missing<T>(store: string, id: string): Answer<T> {
  return refused(404, 'not_found', `No ${store} item ${JSON.stringify(id)} in this profile.`);
}

function message(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
