import type { BlobStore } from '#connectivity';
import {
  splitOptionalFrontmatter,
  stringList,
  withFrontmatter,
} from '#providers/shared/frontmatter.ts';
import { slugify as slugifyText } from '#providers/shared/slug.ts';

/**
 * How an entity is stored, and the only place that knows.
 *
 * **One entity is one Markdown file**, exactly as a memory entry and a task
 * are, and for the same reason (ADR-014): `lanes link entities` and a text
 * editor reach the same bytes, and there is no row anywhere that can disagree
 * with the file it describes. The document is frontmatter — type, name,
 * aliases, tags, attributes, relations, timestamp — above a body that is the
 * owner's notes on this person or thing.
 *
 * The `_index.json` beside these files is a *derived* artefact and is not a
 * counter-example: it carries a fingerprint of the files it was built from and
 * is rebuilt from them whenever that fingerprint disagrees. See `catalogue.ts`.
 *
 * **`attributes` is a list, not a map**, and the argument is identity's,
 * verbatim (`#profile/identity.ts`): a map cannot say *when* to use which, and
 * a map silently forbids two email addresses — the case that matters most.
 * Order is preference order, so the first of a kind is the default.
 *
 * **`relations` is one-sided.** An edge is written into the entity that
 * declares it and nowhere else; the reverse direction is derived when the
 * catalogue is built. Writing both sides would be two files for one fact, and
 * nothing in this codebase locks — an interrupted write would leave a half-edge
 * that nothing detects.
 *
 * The store arrives scoped to `entities/<connection>` by core, so nothing here
 * prefixes a key or thinks about isolation.
 */

/** One addressable fact about an entity: an address, a handle, a number. */
export interface Attribute {
  readonly kind: string;
  readonly value: string;
  /** When this one applies, in the owner's words. See `identityEntrySchema`. */
  readonly note?: string;
}

/** A typed edge to another entity, as written on the entity that declares it. */
export interface Relation {
  readonly predicate: string;
  /** An entity id. Not required to exist — see `parseEntity`. */
  readonly entity: string;
  readonly note?: string;
}

export interface Entity {
  readonly id: string;
  /** `person`, `company`, `project` — or anything else. Never a closed list. */
  readonly type: string;
  /** Falls back to the id, as a memory entry's title does. */
  readonly name: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  /** Preference order: the first of a kind is the default. */
  readonly attributes: readonly Attribute[];
  readonly relations: readonly Relation[];
  readonly updatedAt: string;
  readonly body: string;
  readonly bytes: number;
}

const ENTITY_ID = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * What a `kind` or a `predicate` may be, enforced on write only.
 *
 * The same shape `identityEntrySchema.kind` holds, so an agent that has read
 * `identity_list` recognises an entity's attributes without learning a second
 * format. Free-form within that shape: `signal` and `bluesky` must not need a
 * release, which is why this is a character class and not an enum.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export function entityKey(id: string): string {
  return `${id}.md`;
}

/**
 * The id a key holds, or null for a key that is not an entity.
 *
 * This one predicate is what keeps `_index.json` out of the entity listing, out
 * of the fingerprint, out of the resource listing and out of the CLI listing —
 * four places, no special case in any of them.
 */
export function idFromKey(key: string): string | null {
  if (!key.endsWith('.md')) return null;
  const id = key.slice(0, -'.md'.length);
  return ENTITY_ID.test(id) ? id : null;
}

export function assertEntityId(id: string): void {
  if (!ENTITY_ID.test(id)) {
    throw new Error(
      `Entity id ${JSON.stringify(id)} must be lowercase letters, digits, "_" or "-".`,
    );
  }
}

export function assertKind(kind: string, label: 'kind' | 'predicate'): void {
  if (!IDENTIFIER.test(kind)) {
    throw new Error(
      `Attribute ${label} ${JSON.stringify(kind)} must be lowercase letters, digits and ` +
        `underscores, starting with a letter — "email", "github", "works_at".`,
    );
  }
}

/** A stable id from a name, so writing does not demand one be invented. */
export function slugify(name: string): string {
  return slugifyText(name, 'entity');
}

/**
 * Parse one stored entity, tolerating anything.
 *
 * Every field falls back and no fallback is an error, because this reads a
 * directory the owner is invited to edit. A plain Markdown file dropped in
 * there is an entity named after its filename, which is a better answer than an
 * exception that hides every other entity behind it.
 *
 * A malformed row inside `attributes` or `relations` is **skipped rather than
 * thrown**, and that is the same argument one level down: one bad list item
 * must not cost the whole directory. The visible failure is an attribute that
 * did not appear, which is diagnosable by opening the file; the alternative is
 * a listing that will not render and does not say which file broke it.
 */
export function parseEntity(id: string, text: string, fallbackUpdatedAt: string): Entity {
  const { frontmatter, body } = splitOptionalFrontmatter(text);

  const type = frontmatter['type'];
  const name = frontmatter['name'];
  const updatedAt = frontmatter['updated_at'];

  return {
    id,
    type: typeof type === 'string' && type.trim().length > 0 ? type.trim() : '',
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : id,
    aliases: stringList(frontmatter['aliases']),
    tags: stringList(frontmatter['tags']),
    attributes: parseAttributes(frontmatter['attributes']),
    relations: parseRelations(frontmatter['relations']),
    updatedAt: typeof updatedAt === 'string' ? updatedAt : fallbackUpdatedAt,
    body: body.trimEnd(),
    bytes: new TextEncoder().encode(text).byteLength,
  };
}

function parseAttributes(raw: unknown): Attribute[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    const kind = field(item, 'kind');
    const value = field(item, 'value');
    if (kind === null || value === null) return [];

    const note = field(item, 'note');
    return [{ kind, value, ...(note === null ? {} : { note }) }];
  });
}

function parseRelations(raw: unknown): Relation[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    const predicate = field(item, 'predicate');
    const entity = field(item, 'entity');
    if (predicate === null || entity === null) return [];

    const note = field(item, 'note');
    return [{ predicate, entity, ...(note === null ? {} : { note }) }];
  });
}

/** One non-empty string field off a frontmatter row, or null. */
function field(item: unknown, key: string): string | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const raw = (item as Record<string, unknown>)[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function serialiseEntity(entity: Omit<Entity, 'id' | 'bytes'>): string {
  return withFrontmatter(
    {
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
    },
    `${entity.body.trimEnd()}\n`,
  );
}

export async function readEntity(storage: BlobStore, id: string): Promise<Entity | null> {
  const bytes = await storage.get(entityKey(id));
  if (bytes === null) return null;

  return parseEntity(id, new TextDecoder().decode(bytes), new Date(0).toISOString());
}

/** Write one entity, returning the byte length the catalogue's fingerprint needs. */
export async function writeEntity(storage: BlobStore, entity: Entity): Promise<number> {
  const { id: _id, bytes: _bytes, ...rest } = entity;
  const encoded = new TextEncoder().encode(serialiseEntity(rest));

  await storage.put(entityKey(entity.id), encoded, { contentType: 'text/markdown' });
  return encoded.byteLength;
}

/**
 * How many entities are read at once.
 *
 * The bound memory and tasks use, for the reason memory gives: against a bucket
 * each read is an HTTPS request, and firing a thousand at once trades a slow
 * rebuild for a rate-limited one.
 */
const READ_CONCURRENCY = 16;

/**
 * Every entity, newest first.
 *
 * **This reads every file**, and is the expensive path this provider exists to
 * avoid taking twice: it runs when the catalogue's index is absent, stale or
 * unreadable, and never on a read that found a valid one. `catalogue.ts` has
 * the arithmetic for what that costs at a thousand entities on a bucket.
 */
export async function allEntities(storage: BlobStore): Promise<Entity[]> {
  const blobs = (await storage.list()).flatMap((blob) => {
    const id = idFromKey(blob.key);
    return id === null ? [] : [{ blob, id }];
  });

  const entities: Entity[] = [];

  for (let start = 0; start < blobs.length; start += READ_CONCURRENCY) {
    const batch = await Promise.all(
      blobs.slice(start, start + READ_CONCURRENCY).map(async ({ blob, id }) => {
        const bytes = await storage.get(blob.key);
        return bytes === null
          ? null
          : parseEntity(id, new TextDecoder().decode(bytes), blob.modifiedAt.toISOString());
      }),
    );
    for (const entity of batch) if (entity) entities.push(entity);
  }

  return entities.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The pieces `lanes link entities` needs to reach the same bytes the provider does. */
export const entityStorage = {
  key: entityKey,
  idFromKey,
  parse: parseEntity,
  serialise: serialiseEntity,
  read: readEntity,
  write: writeEntity,
  all: allEntities,
  slugify,
};
