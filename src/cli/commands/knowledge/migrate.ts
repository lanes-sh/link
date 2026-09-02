import {
  ConfigError,
  KNOWLEDGE_LAYOUT,
  KNOWLEDGE_PREFIX,
  knowledgeRoot,
  type KnowledgeArea,
  type KnowledgeConfig,
} from '#profile';
import type { BlobStore } from '#stores/blobs';
import { commitFiles, type CommitFile } from '#deployments/adapters/github-commit.ts';
import type { GithubRepository } from '#deployments/adapters/github-repo.ts';
import { print, style } from '../../output.ts';

/**
 * Moving what is already stored, in whichever direction.
 *
 * Four steps, and the order is the whole of the safety: **read, commit, verify,
 * then delete.** A migration that deleted first, or that trusted a write it had
 * not read back, would leave an owner with no memory and a plausible-looking
 * success line. Nothing here deletes anything until the destination has been
 * re-read and found to hold every byte that was sent.
 *
 * The write is **one commit**, through the Git Data API rather than one
 * Contents call per file. Two hundred commits each reading "Store memory
 * a-note.md" is not a history anybody opens, and it is two hundred round trips
 * against a limit this endpoint now shares.
 */

export interface Movable {
  /** The key in the local store — `main/note.md`, or `triage/SKILL.md`. */
  readonly key: string;
  /** Where it goes in the repository. */
  readonly path: string;
  readonly area: KnowledgeArea;
  readonly data: Uint8Array;
}

/**
 * Where each area lives locally, as one table.
 *
 * Two of the three are prefixes inside the profile's blob root and the third is
 * a store of its own, and that asymmetry was written out three times before —
 * once per direction — which is three places to forget a fourth area. Stating
 * it once means `localContents`, `removeLocal` and `moveOut` each became a loop
 * over this rather than a branch on a literal.
 */
/**
 * One area's local home: where to look, and what of that key is the repository's.
 *
 * Two prefixes rather than one, and the difference is the whole fix. `scope` is
 * what is listed — `memory/<instance>/`, so a profile sees only the instance it
 * grants. `prefix` is what is stripped to get the repository path, which stays
 * `memory/<instance>/<file>` because that is the layout ADR-041 documents and
 * what makes two profiles' notes distinguishable in one repository.
 *
 * Collapsing them listed every profile's memory and then wrote it flat.
 */
type LocalArea = {
  readonly store: BlobStore;
  readonly scope: string;
  readonly prefix: string;
};

/** The connection ids this profile's memory and entities live under. */
export interface Instances {
  readonly memory: string;
  readonly entities: string;
}

function localAreas(
  storage: BlobStore,
  skills: BlobStore | null,
  /** Which instance of each surface this profile grants (ADR-059). */
  instances: Instances,
): Record<KnowledgeArea, LocalArea> {
  return {
    // Scoped to the instance this profile grants, not to the surface.
    //
    // `layout.blobs()` is the whole workspace since contract 3, so a prefix of
    // `memory/` matched every profile's memory — and `knowledge use github
    // --migrate --profile personal` therefore committed `work`'s notes to
    // personal's repository and then deleted them locally, leaving `work`
    // reading an empty store with no knowledge block of its own. `skills` was
    // already connection-scoped, which is why it alone was correct.
    // `scope` reads the *local* store and `prefix` names the repository
    // directory, and since contract 4 those are different strings:
    // `lanes_memory/lan1/` on disk becomes `memory/lan1/` in the repository.
    // Reading one where the other belongs finds nothing and reports success.
    memory: {
      store: storage,
      scope: `${KNOWLEDGE_PREFIX.memory}/${instances.memory}/`,
      prefix: `${KNOWLEDGE_PREFIX.memory}/`,
    },
    // Null becomes an empty area rather than a refusal: a profile granting no
    // skills connection has none to move, and `knowledge use` should still move
    // its memory and entities rather than failing on the one area that is empty
    // by construction (ADR-059).
    skills: { store: skills ?? EMPTY_AREA, scope: '', prefix: '' },
    entities: {
      store: storage,
      scope: `${KNOWLEDGE_PREFIX.entities}/${instances.entities}/`,
      prefix: `${KNOWLEDGE_PREFIX.entities}/`,
    },
  };
}

/** Nothing to list, nothing to delete. See `localAreas`. */
const EMPTY_AREA: BlobStore = {
  get: async () => null,
  put: async () => {},
  has: async () => false,
  delete: async () => {},
  list: async () => [],
};

const AREAS = ['memory', 'skills', 'entities'] as const;

/**
 * Everything this profile has stored locally, ready to move.
 *
 * Memory is read from the profile's blob root under the provider's own
 * namespace rather than from the connections the config declares. A connection
 * removed from the file leaves its entries behind, and those entries are still
 * the owner's — leaving them on a disk that is about to stop being consulted is
 * how they would be lost without anything saying so.
 */
export async function localContents(
  storage: BlobStore,
  /** Null when the profile grants no skills connection (ADR-059). */
  skills: BlobStore | null,
  knowledge: KnowledgeConfig,
  instances: Instances,
): Promise<Movable[]> {
  const areas = localAreas(storage, skills, instances);
  const found: Movable[] = [];

  for (const area of AREAS) {
    const { store, scope, prefix } = areas[area];

    for (const entry of await store.list(scope)) {
      const data = await store.get(entry.key);
      if (data === null) continue; // Listed then deleted; not worth failing over.

      const key = entry.key.slice(prefix.length);
      found.push({ key, area, path: `${knowledgeRoot(knowledge, area)}/${key}`, data });
    }
  }

  return found;
}

/** Paths the repository already holds that a migration would overwrite. */
export async function collisions(
  repository: GithubRepository,
  movable: readonly Movable[],
): Promise<string[]> {
  const { entries } = await repository.entries();
  return movable.filter((item) => entries.has(item.path)).map((item) => item.path);
}

/**
 * Commit everything, then read it back before saying so.
 *
 * The verification is not ceremony. `commitFiles` reports what GitHub answered,
 * and what this needs to know is what GitHub *stored* — which is a different
 * question the moment a tree is built against a base that moved, or a blob
 * upload succeeded and its tree entry did not. One extra request buys the right
 * to delete the only other copy.
 */
export async function moveIn(
  repository: GithubRepository,
  movable: readonly Movable[],
  message: string,
): Promise<void> {
  const files: CommitFile[] = movable.map((item) => ({ path: item.path, data: item.data }));
  await commitFiles(repository, files, [], message);

  const { entries } = await repository.entries();
  const missing = movable.filter((item) => entries.get(item.path)?.size !== item.data.byteLength);

  if (missing.length > 0) {
    throw new ConfigError(
      `The commit landed but ${missing.length} of ${movable.length} files did not read back ` +
        `correctly (first: ${missing[0]?.path}). Nothing local has been deleted and the config ` +
        'has not been changed, so this profile is exactly as it was. Try again.',
    );
  }
}

/** Remove what has been verified elsewhere. Never called before `moveIn`. */
export async function removeLocal(
  storage: BlobStore,
  /** Null when the profile grants no skills connection (ADR-059). */
  skills: BlobStore | null,
  movable: readonly Movable[],
  instances: Instances,
): Promise<void> {
  const areas = localAreas(storage, skills, instances);

  for (const item of movable) {
    const { store, prefix } = areas[item.area];
    await store.delete(`${prefix}${item.key}`);
  }
}

/**
 * The other direction: everything in the repository, written back to the
 * profile's own storage.
 *
 * Nothing is deleted from the repository. It is version control — the history
 * holds every entry regardless of what the tip says — so removing the files
 * would buy no privacy and would throw away the copy somebody may still want.
 * The command says so rather than deciding it silently.
 */
export async function moveOut(
  repository: GithubRepository,
  knowledge: KnowledgeConfig,
  storage: BlobStore,
  /** Null when the profile grants no skills connection (ADR-059). */
  skills: BlobStore | null,
  instances: Instances,
): Promise<Record<KnowledgeArea, number>> {
  const { entries } = await repository.entries();
  const areas = localAreas(storage, skills, instances);
  const counts: Record<KnowledgeArea, number> = { memory: 0, skills: 0, entities: 0 };

  for (const entry of entries.values()) {
    for (const area of AREAS) {
      const root = `${knowledgeRoot(knowledge, area)}/`;
      if (!entry.path.startsWith(root)) continue;

      const key = entry.path.slice(root.length);
      const { store, prefix } = areas[area];
      await store.put(`${prefix}${key}`, await repository.blob(entry.sha));

      counts[area] += 1;
    }
  }

  return counts;
}

/** `12 skills and 47 memory entries`, or whichever parts of that are non-zero. */
export function summarise(movable: readonly Movable[]): string {
  const count = (area: KnowledgeArea) => movable.filter((item) => item.area === area).length;
  const skills = count('skills');
  const memory = count('memory');
  const entities = count('entities');

  // Skills and memory keep their existing wording and their existing order: a
  // third clause is an addition to this sentence, not a rewrite of it.
  const parts = [
    ...(skills > 0 ? [`${skills} skill${skills === 1 ? '' : 's'}`] : []),
    ...(memory > 0 ? [`${memory} memory entr${memory === 1 ? 'y' : 'ies'}`] : []),
    ...(entities > 0 ? [`${entities} entit${entities === 1 ? 'y' : 'ies'}`] : []),
  ];
  return parts.length === 0 ? 'nothing' : parts.join(' and ');
}

export function printMovable(movable: readonly Movable[]): void {
  for (const item of movable) {
    print(`  ${style.green('→')} ${style.dim(`${item.path}`)}`);
  }
}
