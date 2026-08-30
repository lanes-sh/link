import { createHash } from 'node:crypto';
import type { BlobMetadata, BlobStore } from '#connectivity';
import { allEntities, idFromKey, type Attribute, type Entity, type Relation } from './store.ts';

/**
 * The derived index, and the rules that keep it from becoming a second source
 * of truth.
 *
 * `_index.json` sits beside the entity files and holds what a lookup needs, so
 * a read that finds it valid opens no entity file at all. It is a **cache**:
 * absent, truncated, wrong-version and fingerprint-mismatched are all one case
 * here, and all four rebuild from the files without throwing. The precedent is
 * `openRuntime`'s treatment of a corrupt discovery cache — never a reason to
 * fail startup.
 *
 * ADR-014 removed an index from memory because it could disagree with the file
 * it described. What makes this one different is the fingerprint: it is a stamp
 * of the exact listing the index was built from, so a file edited in an editor
 * or on GitHub invalidates it structurally rather than by anybody remembering
 * to. The hole that remains — a hand-edited *index* whose fingerprint still
 * matches untouched entity files — is closed on the path that matters by the
 * confirm-on-read rule in `find.ts`, and is pinned by a test rather than
 * pretended away.
 *
 * **Why the fingerprint is `key:size` and not `key:size:mtime`.**
 * `skillFingerprint` includes mtime and is right to: it is a change detector
 * for a two-second poll, where a false positive costs a reload. This is a
 * validity stamp, where a false positive costs a full rebuild and, on a
 * knowledge repository, a commit. The GitHub adapter reports the *branch tip*
 * as `modifiedAt` for every file, so on the one backend where this index is
 * worth the most, an mtime-bearing fingerprint would never match twice. Sizes
 * are per-file on every adapter.
 *
 * That choice buys a second property the write path depends on: because size is
 * known before a put, a writer can compute the fingerprint of the state it is
 * *about to create* (`fingerprintAfter`) rather than listing the store again
 * afterwards. No read-back, no second `list()`, no ordering hazard.
 *
 * **No read ever writes this file.** A read that finds it stale rebuilds in
 * memory and serves the right answer. Only `write`, `link`, `forget` and
 * `entities reindex` persist. So no read can move a branch tip, and therefore
 * no read can invalidate the next read.
 *
 * **What it costs, at scale.** Steady state on a bucket is one `list()` and one
 * GET, whatever the entity count — a listing carries key and size only, so no
 * body is transferred on that path. A rebuild is one read per entity, bounded
 * 16 at a time.
 *
 *   entities   list() requests   index   steady-state read   rebuild
 *   100        1                 ~35 KB  2 requests          100 GETs
 *   1,000      1-2               ~340 KB 3 requests          1,000 GETs
 *   10,000     11                ~3.4 MB 12 requests         10,000 GETs
 *
 * A thousand is comfortably inside the design. Ten thousand is where it is the
 * wrong design, and the answer then is not a larger index but a validity check
 * that needs no listing — which needs an adapter reporting a per-object etag,
 * and `BlobMetadata` carries none today. On a local directory none of this is
 * worth anything measurable; it is carried for the deployed and repository
 * paths.
 */

export const INDEX_KEY = '_index.json';

/**
 * Bumping this invalidates every stored index without anyone remembering to.
 *
 * It is in the fingerprint's own prefix rather than checked separately, so a
 * format change and a content change are one comparison.
 */
const INDEX_VERSION = 1;

/**
 * An entity as the index holds it: everything that matches or distinguishes,
 * and nothing that only renders.
 *
 * No body, and no body summary. A summary would be the largest field per row
 * and nothing consults it — a single match reads the file anyway under
 * confirm-on-read, and several matches render the fields that *differ*, not
 * prose. Dropping it is about a third of the file for no loss.
 */
export type CatalogueEntity = Omit<Entity, 'body' | 'bytes'>;

/** An edge as the entity it points *at* sees it. Derived, never stored. */
export interface Backlink {
  readonly from: string;
  readonly predicate: string;
  readonly note?: string;
}

export interface Catalogue {
  readonly entities: readonly CatalogueEntity[];
  readonly byId: ReadonlyMap<string, CatalogueEntity>;
  /** Reverse edges, derived in one pass. Keyed by the entity pointed at. */
  readonly backlinks: ReadonlyMap<string, readonly Backlink[]>;
  readonly fingerprint: string;
  /**
   * Whether this came from a valid index rather than from the files.
   *
   * `find` reads it to decide whether a single match needs confirming against
   * its file: an answer rebuilt from the files is already confirmed.
   */
  readonly fromIndex: boolean;
  /**
   * The listing this was opened against.
   *
   * Carried so a write can compute `fingerprintAfter` without listing twice.
   * It is the one piece of storage detail on this type and it is here rather
   * than fetched again because the two calls could otherwise see different
   * states.
   */
  readonly listing: readonly BlobMetadata[];
}

/**
 * A stamp of exactly which entity files existed and how large each was.
 *
 * Filtered by `idFromKey`, which is what keeps `_index.json` out of its own
 * fingerprint. Without that filter, writing the index would change the listing,
 * which would invalidate the index the instant it was written.
 */
export function fingerprintOf(blobs: readonly BlobMetadata[]): string {
  return hashLines(
    blobs.flatMap((blob) => (idFromKey(blob.key) === null ? [] : [`${blob.key}:${blob.size}`])),
  );
}

/** What `fingerprintOf` will return after this put or delete lands. */
export function fingerprintAfter(
  blobs: readonly BlobMetadata[],
  change: { key: string; size: number } | { key: string; deleted: true },
): string {
  const lines = blobs.flatMap((blob) =>
    idFromKey(blob.key) === null || blob.key === change.key ? [] : [`${blob.key}:${blob.size}`],
  );

  if (!('deleted' in change) && idFromKey(change.key) !== null) {
    lines.push(`${change.key}:${change.size}`);
  }

  return hashLines(lines);
}

function hashLines(lines: readonly string[]): string {
  return createHash('sha256')
    .update(`entities/${INDEX_VERSION}\n${[...lines].sort().join('\n')}`)
    .digest('hex');
}

/**
 * The catalogue, from the index when it is valid and from the files when it is
 * not.
 *
 * Never throws for a storage-shaped reason. The only thing that propagates is a
 * failure to `list()` at all, which is the store being unreachable rather than
 * this cache being wrong.
 */
export async function openCatalogue(storage: BlobStore): Promise<Catalogue> {
  const listing = await storage.list();
  const fingerprint = fingerprintOf(listing);

  const indexed = await readIndex(storage, fingerprint);
  if (indexed !== null) return assemble(indexed, fingerprint, true, listing);

  const entities = (await allEntities(storage)).map(strip);
  return assemble(entities, fingerprint, false, listing);
}

/** Rebuild from the files regardless of what the index says. */
export async function rebuildCatalogue(storage: BlobStore): Promise<Catalogue> {
  const listing = await storage.list();
  const entities = (await allEntities(storage)).map(strip);

  return assemble(entities, fingerprintOf(listing), false, listing);
}

export async function writeCatalogue(
  storage: BlobStore,
  entities: readonly CatalogueEntity[],
  fingerprint: string,
  now: string,
): Promise<void> {
  await storage.put(INDEX_KEY, new TextEncoder().encode(serialiseIndex(entities, fingerprint, now)), {
    contentType: 'application/json',
  });
}

/** Why a read had to rebuild, for `entities reindex` and a debug log line. */
export async function indexState(
  storage: BlobStore,
): Promise<{ current: boolean; reason: string }> {
  const fingerprint = fingerprintOf(await storage.list());
  const bytes = await storage.get(INDEX_KEY);

  if (bytes === null) return { current: false, reason: 'no index file' };

  const parsed = parseIndex(bytes);
  if (parsed === null) return { current: false, reason: 'the index file could not be read' };
  if (parsed.fingerprint !== fingerprint) {
    return { current: false, reason: 'the entity files changed since the index was built' };
  }

  return { current: true, reason: 'the index matches the entity files' };
}

function strip(entity: Entity): CatalogueEntity {
  const { body: _body, bytes: _bytes, ...rest } = entity;
  return rest;
}

/**
 * A catalogue over entities already in hand, deriving the backlinks.
 *
 * The same assembly both open paths use, exposed so `find` can be exercised
 * against literal arrays with no store at all — which is the point of keeping
 * matching pure.
 */
export function catalogueFrom(entities: readonly CatalogueEntity[]): Catalogue {
  return assemble(entities, '', false, []);
}

function assemble(
  entities: readonly CatalogueEntity[],
  fingerprint: string,
  fromIndex: boolean,
  listing: readonly BlobMetadata[],
): Catalogue {
  const byId = new Map(entities.map((one) => [one.id, one]));
  const backlinks = new Map<string, Backlink[]>();

  // One pass over the forward edges already loaded. Reverse edges are never
  // stored: a second copy inside the same file could disagree with the first
  // half of it, and this derivation is shared by both open paths so there is
  // one implementation of "who points at this".
  for (const entity of entities) {
    for (const relation of entity.relations) {
      const into = backlinks.get(relation.entity) ?? [];
      into.push({
        from: entity.id,
        predicate: relation.predicate,
        ...(relation.note === undefined ? {} : { note: relation.note }),
      });
      backlinks.set(relation.entity, into);
    }
  }

  return { entities, byId, backlinks, fingerprint, fromIndex, listing };
}

/** The stored rows, or null for any reason at all. Every reason rebuilds. */
async function readIndex(
  storage: BlobStore,
  fingerprint: string,
): Promise<CatalogueEntity[] | null> {
  const bytes = await storage.get(INDEX_KEY);
  if (bytes === null) return null;

  const parsed = parseIndex(bytes);
  if (parsed === null || parsed.fingerprint !== fingerprint) return null;

  return parsed.entities;
}

function parseIndex(
  bytes: Uint8Array,
): { fingerprint: string; entities: CatalogueEntity[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const document = raw as Record<string, unknown>;

  if (document['v'] !== INDEX_VERSION) return null;
  if (typeof document['fingerprint'] !== 'string') return null;
  if (!Array.isArray(document['entities'])) return null;

  const entities: CatalogueEntity[] = [];
  for (const row of document['entities']) {
    const entity = parseRow(row);
    // One unreadable row is the whole file: unlike an entity document, this is
    // machine-written and a partial one means a partial answer with nothing
    // saying so. Rebuilding is cheap and correct.
    if (entity === null) return null;
    entities.push(entity);
  }

  return { fingerprint: document['fingerprint'], entities };
}

function parseRow(raw: unknown): CatalogueEntity | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const id = row['id'];
  const updatedAt = row['updated_at'];
  if (typeof id !== 'string' || typeof updatedAt !== 'string') return null;

  return {
    id,
    type: typeof row['type'] === 'string' ? row['type'] : '',
    name: typeof row['name'] === 'string' ? row['name'] : id,
    aliases: strings(row['aliases']),
    tags: strings(row['tags']),
    attributes: rows<Attribute>(row['attributes'], ['kind', 'value']),
    relations: rows<Relation>(row['relations'], ['predicate', 'entity']),
    updatedAt,
  };
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : [];
}

function rows<T>(raw: unknown, required: readonly [string, string]): T[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const one = item as Record<string, unknown>;
    if (required.some((key) => typeof one[key] !== 'string')) return [];

    const note = one['note'];
    return [
      {
        [required[0]]: one[required[0]],
        [required[1]]: one[required[1]],
        ...(typeof note === 'string' ? { note } : {}),
      } as T,
    ];
  });
}

/**
 * Sorted by id, fixed key order, two-space indent.
 *
 * Determinism is not cosmetic: this lands in a git diff on the owner's own
 * notes repository, and a file that reorders itself makes a one-attribute
 * change unreviewable.
 */
function serialiseIndex(
  entities: readonly CatalogueEntity[],
  fingerprint: string,
  now: string,
): string {
  const rows = [...entities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entity) => ({
      id: entity.id,
      ...(entity.type ? { type: entity.type } : {}),
      name: entity.name,
      ...(entity.aliases.length > 0 ? { aliases: [...entity.aliases] } : {}),
      ...(entity.tags.length > 0 ? { tags: [...entity.tags] } : {}),
      ...(entity.attributes.length > 0
        ? { attributes: entity.attributes.map((one) => ({ ...one })) }
        : {}),
      ...(entity.relations.length > 0
        ? { relations: entity.relations.map((one) => ({ ...one })) }
        : {}),
      updated_at: entity.updatedAt,
    }));

  return `${JSON.stringify({ v: INDEX_VERSION, fingerprint, built_at: now, entities: rows }, null, 2)}\n`;
}
