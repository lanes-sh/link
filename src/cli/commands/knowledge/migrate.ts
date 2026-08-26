import { ConfigError, KNOWLEDGE_LAYOUT, knowledgeRoot, type KnowledgeConfig } from '#profile';
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
  readonly area: 'memory' | 'skills';
  readonly data: Uint8Array;
}

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
  skills: BlobStore,
  knowledge: KnowledgeConfig,
): Promise<Movable[]> {
  const found: Movable[] = [];
  const prefix = `${KNOWLEDGE_LAYOUT.memory}/`;

  for (const entry of await storage.list(prefix)) {
    const data = await storage.get(entry.key);
    if (data === null) continue; // Listed then deleted; not worth failing over.
    const key = entry.key.slice(prefix.length);
    found.push({
      key,
      area: 'memory',
      path: `${knowledgeRoot(knowledge, 'memory')}/${key}`,
      data,
    });
  }

  for (const entry of await skills.list()) {
    const data = await skills.get(entry.key);
    if (data === null) continue;
    found.push({
      key: entry.key,
      area: 'skills',
      path: `${knowledgeRoot(knowledge, 'skills')}/${entry.key}`,
      data,
    });
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
  skills: BlobStore,
  movable: readonly Movable[],
): Promise<void> {
  for (const item of movable) {
    if (item.area === 'memory') await storage.delete(`${KNOWLEDGE_LAYOUT.memory}/${item.key}`);
    else await skills.delete(item.key);
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
  skills: BlobStore,
): Promise<{ memory: number; skills: number }> {
  const { entries } = await repository.entries();
  const roots = {
    memory: `${knowledgeRoot(knowledge, 'memory')}/`,
    skills: `${knowledgeRoot(knowledge, 'skills')}/`,
  } as const;

  const counts = { memory: 0, skills: 0 };

  for (const entry of entries.values()) {
    for (const area of ['memory', 'skills'] as const) {
      if (!entry.path.startsWith(roots[area])) continue;

      const key = entry.path.slice(roots[area].length);
      const data = await repository.blob(entry.sha);

      if (area === 'memory') await storage.put(`${KNOWLEDGE_LAYOUT.memory}/${key}`, data);
      else await skills.put(key, data);

      counts[area] += 1;
    }
  }

  return counts;
}

/** `12 skills and 47 memory entries`, or whichever half of that is non-zero. */
export function summarise(movable: readonly Movable[]): string {
  const skills = movable.filter((item) => item.area === 'skills').length;
  const memory = movable.length - skills;

  const parts = [
    ...(skills > 0 ? [`${skills} skill${skills === 1 ? '' : 's'}`] : []),
    ...(memory > 0 ? [`${memory} memory entr${memory === 1 ? 'y' : 'ies'}`] : []),
  ];
  return parts.length === 0 ? 'nothing' : parts.join(' and ');
}

export function printMovable(movable: readonly Movable[]): void {
  for (const item of movable) {
    print(`  ${style.green('→')} ${style.dim(`${item.path}`)}`);
  }
}
