import { loadProfileSkills, readSkill } from '#providers/skills/store.ts';
import { assetStorage, entityStorage, memoryStorage, taskStorage } from '#providers/owner.ts';
import type { BlobStore } from '#stores/blobs';
import type { Runtime } from '../runtime.ts';
import { storeFor } from './stores.ts';
import {
  answered,
  refused,
  type Answer,
  type DataContent,
  type DataDetail,
  type DataItem,
  type DataStoreName,
} from './surface.ts';

/**
 * Reading the six stores, through the modules that own their formats.
 *
 * Nothing here parses a document itself. `memoryStorage`, `taskStorage`,
 * `assetStorage` and `entityStorage` are the same objects the providers and the
 * CLI read through, and `loadProfileSkills` is the same loader the registry
 * builds from — so a listing here cannot come to disagree with the listing an
 * agent sees, which is the whole reason those namespace objects are exported.
 *
 * **A detail carries the document raw.** Frontmatter included, exactly as it
 * sits on the store. The alternative was projecting each format into fields and
 * reassembling them on the way back, which is a second copy of five schemas and
 * a lossy round trip for anything the projection did not know about.
 */

/** What a listing returns at most, whatever was asked for. */
const LIMIT_CEILING = 500;
const LIMIT_DEFAULT = 200;

/**
 * The largest asset served as an editable document.
 *
 * The provider's own ceiling for handing text to a model, reused here because
 * the question is close enough: past this a text box is not a sensible way to
 * look at a file, and the content route serves the bytes instead.
 */
const MAX_TEXT_BYTES = 256 * 1024;

function bounded(limit: number | undefined): number {
  return Math.min(limit && limit > 0 ? limit : LIMIT_DEFAULT, LIMIT_CEILING);
}

/** Case-insensitive substring, which is the match every one of these stores makes. */
function matches(query: string | undefined, ...fields: readonly string[]): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export async function listItems(
  runtime: Runtime,
  store: DataStoreName,
  options: { query?: string | undefined; limit?: number | undefined },
): Promise<Answer<DataItem[]>> {
  const limit = bounded(options.limit);

  if (store === 'vault') return listVault(runtime, options.query, limit);

  const scoped = storeFor(runtime, store);
  if (!scoped.ok) return scoped;

  const rows = await collect(scoped.value.store, store, options.query);
  return answered(rows.slice(0, limit));
}

async function collect(
  blobs: BlobStore,
  store: DataStoreName,
  query: string | undefined,
): Promise<DataItem[]> {
  switch (store) {
    case 'memory': {
      const entries = await memoryStorage.all(blobs);
      return entries
        .filter((entry) => matches(query, entry.id, entry.title, entry.tags.join(' '), entry.body))
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          summary: null,
          updatedAt: entry.updatedAt,
          tags: entry.tags,
        }));
    }
    case 'tasks': {
      const tasks = await taskStorage.all(blobs);
      return tasks
        .filter((task) => matches(query, task.id, task.title, task.tags.join(' '), task.body))
        .map((task) => ({
          id: task.id,
          title: task.title,
          // Status first, because it is what a task list is scanned for, and
          // the due date beside it because the two are read together.
          summary: task.due ? `${task.status} · due ${task.due}` : task.status,
          updatedAt: task.updatedAt,
          tags: task.tags,
        }));
    }
    case 'assets': {
      const assets = await assetStorage.all(blobs);
      return assets
        .filter((asset) => matches(query, asset.name, asset.contentType))
        .map((asset) => ({
          id: asset.name,
          title: asset.name,
          summary: `${asset.contentType} · ${assetStorage.humanBytes(asset.bytes)}`,
          updatedAt: asset.modifiedAt,
          tags: [],
        }));
    }
    case 'skills': {
      const skills = await loadProfileSkills(blobs);
      return skills
        .filter((skill) => matches(query, skill.name, skill.title ?? '', skill.description))
        .map((skill) => ({
          id: skill.name,
          title: skill.title ?? skill.name,
          summary: skill.description,
          // A skill's document carries no timestamp: its frontmatter is what
          // the owner wrote, and inventing one from the blob's mtime would
          // report a re-sync as an edit.
          updatedAt: null,
          tags: [],
        }));
    }
    case 'entities': {
      const entities = await entityStorage.all(blobs);
      return entities
        .filter((entity) =>
          matches(query, entity.id, entity.name, entity.aliases.join(' '), entity.tags.join(' ')),
        )
        .map((entity) => ({
          id: entity.id,
          title: entity.name,
          summary:
            entity.aliases.length > 0 ? `${entity.type} · ${entity.aliases.join(', ')}` : entity.type,
          updatedAt: entity.updatedAt,
          tags: entity.tags,
        }));
    }
    default:
      return [];
  }
}

/**
 * The vault, by name.
 *
 * Ids and descriptions, and no value under any key. `VaultStore` has no
 * operation that would enumerate one, so this is enforced by what is reachable
 * rather than by remembering not to ask (ADR-007, ADR-069).
 */
async function listVault(
  runtime: Runtime,
  query: string | undefined,
  limit: number,
): Promise<Answer<DataItem[]>> {
  const items = await runtime.vault.ids();

  return answered(
    items
      .filter((item) => matches(query, item.id, item.description ?? ''))
      .map((item) => ({
        id: item.id,
        title: item.id,
        summary: item.description ?? null,
        updatedAt: null,
        tags: [],
      }))
      .slice(0, limit),
  );
}

export async function readItem(
  runtime: Runtime,
  store: DataStoreName,
  id: string,
): Promise<Answer<DataDetail>> {
  if (store === 'vault') return readVaultItem(runtime, id);

  const scoped = storeFor(runtime, store);
  if (!scoped.ok) return scoped;

  const blobs = scoped.value.store;

  if (store === 'assets') return readAsset(blobs, id);

  const key =
    store === 'memory'
      ? memoryStorage.key(id)
      : store === 'tasks'
        ? taskStorage.key(id)
        : entityStorage.key(id);

  if (store === 'skills') {
    const skill = await readSkill(blobs, id).catch(() => null);
    if (!skill) return missing(store, id);

    // The stored document, frontmatter and all — the same bytes
    // `skills.manage.get` returns, and the same bytes a write puts back.
    const bytes = await blobs.get(skill.path);
    return answered({
      id: skill.name,
      title: skill.title ?? skill.name,
      summary: skill.description,
      updatedAt: null,
      tags: [],
      body: bytes === null ? '' : decode(bytes),
      readOnly: null,
      contentType: 'text/markdown',
      bytes: bytes?.byteLength ?? 0,
    });
  }

  const bytes = await blobs.get(key);
  if (bytes === null) return missing(store, id);

  const rows = await collect(blobs, store, undefined);
  const row = rows.find((one) => one.id === id);

  return answered({
    id,
    title: row?.title ?? id,
    summary: row?.summary ?? null,
    updatedAt: row?.updatedAt ?? null,
    tags: row?.tags ?? [],
    body: decode(bytes),
    readOnly: null,
    contentType: 'text/markdown',
    bytes: bytes.byteLength,
  });
}

async function readAsset(blobs: BlobStore, name: string): Promise<Answer<DataDetail>> {
  const asset = await assetStorage.find(blobs, name);
  if (!asset) return missing('assets', name);

  const bytes = await blobs.get(name);
  const textual =
    bytes !== null && asset.bytes <= MAX_TEXT_BYTES && assetStorage.isTextual(asset.contentType, bytes);

  return answered({
    id: asset.name,
    title: asset.name,
    summary: `${asset.contentType} · ${assetStorage.humanBytes(asset.bytes)}`,
    updatedAt: asset.modifiedAt,
    tags: [],
    body: textual && bytes !== null ? decode(bytes) : null,
    readOnly: textual
      ? null
      : `${assetStorage.describe(asset)} — not text, so it is shown rather than edited.`,
    contentType: asset.contentType,
    bytes: asset.bytes,
  });
}

/**
 * One vault item, which is its name and nothing else.
 *
 * It opens rather than refusing, because a row a person can see and cannot open
 * reads as a fault. What it says is the answer: the value is not readable from
 * here and there is a command that reads it.
 */
async function readVaultItem(runtime: Runtime, id: string): Promise<Answer<DataDetail>> {
  const item = (await runtime.vault.ids()).find((one) => one.id === id);
  if (!item) return missing('vault', id);

  return answered({
    id: item.id,
    title: item.id,
    summary: item.description ?? null,
    updatedAt: null,
    tags: [],
    body: null,
    readOnly:
      'A vault value is never returned to a browser. Read it with "lanes link vault get" at a terminal.',
    contentType: null,
    bytes: null,
  });
}

/** An asset's bytes. The one route where content crosses, and only for assets. */
export async function readContent(runtime: Runtime, name: string): Promise<Answer<DataContent>> {
  const scoped = storeFor(runtime, 'assets');
  if (!scoped.ok) return scoped;

  const asset = await assetStorage.find(scoped.value.store, name);
  if (!asset) return missing('assets', name);

  const bytes = await scoped.value.store.get(name);
  if (bytes === null) return missing('assets', name);

  return answered({ bytes, contentType: asset.contentType });
}

function missing<T>(store: string, id: string): Answer<T> {
  return refused(404, 'not_found', `No ${store} item ${JSON.stringify(id)} in this profile.`);
}
