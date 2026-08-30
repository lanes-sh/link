import { ConfigError } from '#profile';
import { scopeNamespace } from '#dispatch';
import { scopeBlobStore, type BlobStore } from '#stores/blobs';
import {
  indexState,
  openCatalogue,
  rebuildCatalogue,
  writeCatalogue,
} from '#providers/entities/catalogue.ts';
import { matchEntities, type Criteria } from '#providers/entities/find.ts';
import { describe, renderEntity } from '#providers/entities/render.ts';
import { entityStorage, type Attribute, type Entity, type Relation } from '#providers/owner.ts';
import { heading, ok, print, style, table, warn } from '../../output.ts';
import type { Runtime } from '../../runtime.ts';
import { agreed, optionalStdin, ownerConnection, required, withRuntime, type OwnerFlags } from './shared.ts';

/**
 * `lanes link entities` — who and what everyone else is.
 *
 * Reaches the same bytes the provider does, through the same two scoping
 * functions and the same `entityStorage`, `catalogue` and `find` modules. Two
 * spellings of one layout is how a control plane and its data plane drift
 * apart, and here it would drift in a way nothing would notice: a CLI that
 * wrote entity files without maintaining `_index.json` would leave every write
 * costing the next reader a full rebuild.
 */

/** `--attr email=jan@example.test`, or `--attr github` for "has one at all". */
function parseAttr(given: string): { kind: string; value?: string } {
  const at = given.indexOf('=');
  if (at === -1) return { kind: given.trim() };
  return { kind: given.slice(0, at).trim(), value: given.slice(at + 1).trim() };
}

/** `--related works_at=acme-bv`, or `--related acme-bv` for any predicate. */
function parseRelated(given: string): { predicate?: string; entity: string } {
  const at = given.indexOf('=');
  if (at === -1) return { entity: given.trim() };
  return { predicate: given.slice(0, at).trim(), entity: given.slice(at + 1).trim() };
}

function criteriaFrom(query: string | undefined, flags: OwnerFlags): Criteria {
  return {
    query,
    type: flags.type,
    tag: flags.tag,
    attr: flags.attr?.map(parseAttr),
    related: flags.related?.map(parseRelated),
    limit: 50,
  };
}

export async function entitiesFind(query: string | undefined, flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const store = entitiesStore(runtime, flags);
    const catalogue = await openCatalogue(store);
    const criteria = criteriaFrom(query, flags);
    const matches = matchEntities(catalogue, criteria);

    if (matches.candidates.length === 0) {
      heading('Entities (0)');
      print(
        style.dim(
          catalogue.entities.length === 0
            ? '  none — declare one with: lanes link entities write <name>'
            : `  nothing matches ${describe(criteria)}`,
        ),
      );
      return;
    }

    heading(`Entities (${matches.total})`);
    table(
      matches.candidates.map((candidate) => [
        `  ${candidate.entity.id}`,
        candidate.entity.name,
        candidate.entity.type ? style.dim(candidate.entity.type) : '',
        style.dim(candidate.entity.updatedAt.slice(0, 10)),
      ]),
    );

    // The same sentence the tool result carries, for the same reason: the list
    // is not a ranking, and the person reading it is about to pick from it.
    if (matches.candidates.length > 1 && query !== undefined) {
      print('');
      print(style.dim('  more than one matches — the order is not a ranking'));
    }
  });
}

export async function entitiesGet(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const entityId = required(id, 'lanes link entities get <id>');

  await withRuntime(flags, async (runtime) => {
    const store = entitiesStore(runtime, flags);
    const entity = await entityStorage.read(store, entityId);
    if (!entity) throw new ConfigError(`No entity "${entityId}" in this profile.`);

    const catalogue = await openCatalogue(store);
    print('');
    print(renderEntity(entity, catalogue, entity.body));
  });
}

export async function entitiesWrite(name: string | undefined, flags: OwnerFlags): Promise<void> {
  const given = required(name, 'lanes link entities write <name> [--type person] [--attr email=…]');
  // Optional rather than required: an entity legitimately has no prose, and
  // refusing an empty pipe would break every scripted invocation.
  const notes = await optionalStdin();

  await withRuntime(flags, async (runtime) => {
    const store = entitiesStore(runtime, flags);
    const id = flags.name ?? entityStorage.slugify(given);
    const existing = await entityStorage.read(store, id);

    const attributes = flags.attr?.map((one) => {
      const { kind, value } = parseAttr(one);
      if (value === undefined) {
        throw new ConfigError(`--attr ${one} needs a value here: --attr ${kind}=<value>`);
      }
      return { kind, value } satisfies Attribute;
    });

    const relations = flags.related?.map((one) => {
      const { predicate, entity } = parseRelated(one);
      if (predicate === undefined) {
        throw new ConfigError(`--related ${one} needs a predicate: --related <predicate>=${entity}`);
      }
      return { predicate, entity } satisfies Relation;
    });

    // A flag that was not passed keeps what is on disk, exactly as the tool
    // does — `entities write` is how a person corrects one field.
    const next: Entity = {
      id,
      name: given,
      type: flags.type ?? existing?.type ?? '',
      aliases: flags.alias ?? existing?.aliases ?? [],
      tags: flags.tag ? [flags.tag] : (existing?.tags ?? []),
      attributes: attributes ?? existing?.attributes ?? [],
      relations: relations ?? existing?.relations ?? [],
      updatedAt: new Date().toISOString(),
      body: notes ?? existing?.body ?? '',
      bytes: 0,
    };

    await persist(store, next);
    print(ok(`${existing ? 'updated' : 'declared'} entity ${style.bold(id)}`));
  });
}

export async function entitiesLink(
  from: string | undefined,
  edge: string | undefined,
  flags: OwnerFlags,
): Promise<void> {
  const usage = 'lanes link entities link <from> <predicate>=<to>';
  const given = required(from, usage);
  const { predicate, entity: to } = parseRelated(required(edge, usage));
  if (predicate === undefined) {
    throw new ConfigError(`"${edge}" needs a predicate — ${usage}`);
  }

  await withRuntime(flags, async (runtime) => {
    const store = entitiesStore(runtime, flags);
    const entity = await entityStorage.read(store, given);
    if (!entity) throw new ConfigError(`No entity "${given}" in this profile.`);

    if (entity.relations.some((one) => one.predicate === predicate && one.entity === to)) {
      print(style.dim(`  ${given} already ${predicate} ${to}`));
      return;
    }

    await persist(store, {
      ...entity,
      relations: [...entity.relations, { predicate, entity: to }],
      updatedAt: new Date().toISOString(),
    });

    const catalogue = await openCatalogue(store);
    print(ok(`${style.bold(given)} ${predicate} ${style.bold(to)}`));
    if (!catalogue.byId.has(to)) print(warn(`"${to}" is not declared yet — the edge is kept as written`));
  });
}

export async function entitiesForget(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const entityId = required(id, 'lanes link entities forget <id>');

  await withRuntime(flags, async (runtime) => {
    const store = entitiesStore(runtime, flags);
    const catalogue = await openCatalogue(store);
    const entity = catalogue.byId.get(entityId);
    if (!entity) throw new ConfigError(`No entity "${entityId}" in this profile.`);

    const referencedBy = (catalogue.backlinks.get(entityId) ?? []).map((one) => one.from);

    print(`  ${style.bold(entity.id)}  ${entity.name}`);
    // Said before the prompt rather than after the delete: this is the fact
    // that should change the answer, and `forget` deliberately does not cascade.
    if (referencedBy.length > 0) {
      print(warn(`still referenced by ${referencedBy.join(', ')} — those edges will dangle`));
    }
    if (!(await agreed(flags, 'Remove this entity?'))) return;

    await store.delete(entityStorage.key(entityId));
    const remaining = catalogue.entities.filter((one) => one.id !== entityId);
    const rebuilt = await rebuildCatalogue(store);
    await writeCatalogue(store, remaining, rebuilt.fingerprint, new Date().toISOString());

    print(ok(`removed entity ${style.bold(entityId)}`));
  });
}

/**
 * Rebuild `_index.json` from the files, and say why it needed it.
 *
 * The index self-heals on the next write, so this exists for the case a write
 * is not coming: a bulk edit made in an editor or pulled from a knowledge
 * repository, where the next read would otherwise pay a full scan every time.
 */
export async function entitiesReindex(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const store = entitiesStore(runtime, flags);
    const before = await indexState(store);

    if (before.current) {
      print(style.dim(`  index is already current — ${before.reason}`));
      return;
    }

    const catalogue = await rebuildCatalogue(store);
    await writeCatalogue(store, catalogue.entities, catalogue.fingerprint, new Date().toISOString());
    print(ok(`rebuilt the index over ${catalogue.entities.length} entities — ${before.reason}`));
  });
}

/** Write one entity and leave the index describing what is now there. */
async function persist(store: BlobStore, entity: Entity): Promise<void> {
  await entityStorage.write(store, entity);
  const rebuilt = await rebuildCatalogue(store);
  await writeCatalogue(store, rebuilt.entities, rebuilt.fingerprint, entity.updatedAt);
}

/**
 * The blob namespace core would scope this provider to.
 *
 * The same two functions `buildProviderContext` uses, for the reason
 * `memoryStore` gives: a path spelled out again is a path that can differ.
 */
export function entitiesStore(runtime: Runtime, flags: OwnerFlags): BlobStore {
  const connection = ownerConnection(runtime.config, 'entities', flags);
  return scopeBlobStore(runtime.storage, scopeNamespace('entities', connection));
}
