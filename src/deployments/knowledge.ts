import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { knowledgeRoot, type KnowledgeConfig } from '#profile';
import { requireSecret, type TargetInput } from './target.ts';
import type { FetchLike } from './adapters/github-api.ts';
// Type-only, so a target with no `knowledge` block never loads the adapter.
// The same rule `target.ts` follows for the cloud adapters, kept here by the
// fact that a type import is erased entirely.
import type { GithubRepository } from './adapters/github-repo.ts';
// Re-exported so a caller that wants to replace the transport does not have to
// reach past this module into an adapter. It is narrower than
// `typeof globalThis.fetch`, which under Bun's types carries a `preconnect` a
// test double would otherwise have to stub.
export type { FetchLike } from './adapters/github-api.ts';

/**
 * Opening the place a profile keeps its memory and its skills, when that is not
 * the place it keeps everything else.
 *
 * Its own file rather than a fifth case in `target.ts`, because it is not the
 * same kind of decision. `target.ts` answers "where does this target run" —
 * credentials here, bytes there — and every consumer of a `BlobStore` rides
 * that one answer. This answers a narrower one: two directories of documents
 * the owner wrote have somewhere else to be, and nothing else moves with them.
 *
 * ADR-041 has the argument. `src/profile/knowledge.ts` has the contract, and
 * the reason there is no field here that could name the credential store or the
 * vault.
 */

/**
 * One repository client, two stores.
 *
 * Memory and skills are two directories in one repository, and pointing both at
 * one client means one branch head, one tree, and one blob cache between them —
 * so the endpoint's two-second skill poll keeps memory's view current for free.
 * Two clients would each poll, each cache, and could disagree about which
 * commit is current.
 */
export interface KnowledgeStores {
  readonly repository: GithubRepository;
  readonly skills: BlobStore;
  /** Rooted at the repository's memory directory; keys are `<connection>/<id>.md`. */
  readonly memory: BlobStore;
  /** One line for `target show` and `doctor`, so the config file is not the only witness. */
  readonly describe: string;
}

/**
 * `undefined` when the target declares no `knowledge` block — which is every
 * profile written before it existed, so the caller's fallback is the path that
 * has always run rather than a special case.
 */
export async function openKnowledge(
  input: TargetInput,
  secrets: SecretStore,
  /** Injected for tests. The repository is the only thing these stores reach. */
  call?: FetchLike,
): Promise<KnowledgeStores | undefined> {
  const { config, target } = input;
  // On the profile since contract 2: it says where *this profile's* memory and
  // skills live, and a profile lives in exactly one target (ADR-052), so the
  // per-target spelling it replaced could no longer say anything extra.
  const knowledge = config.knowledge;
  if (!knowledge) return undefined;

  const token = await requireSecret(
    secrets,
    knowledge.token_ref,
    `targets.${target}.knowledge.token_ref`,
    target,
    'the github adapter',
  );

  const { GithubRepository } = await import('./adapters/github-repo.ts');
  const repository = new GithubRepository({
    repo: knowledge.repo,
    token,
    ...(knowledge.branch !== undefined ? { branch: knowledge.branch } : {}),
    ...(call ? { fetch: call } : {}),
  });

  return {
    repository,
    ...(await knowledgeStores(repository, knowledge)),
    describe: describeKnowledge(knowledge),
  };
}

/**
 * The two stores a knowledge repository holds.
 *
 * Separate from `openKnowledge` because `lanes link knowledge use` builds these
 * against a repository it is still probing — before any of it has been written
 * into the config `openKnowledge` reads. Two spellings of one layout is how a
 * migration comes to write where nothing later looks.
 */
export async function knowledgeStores(
  repository: GithubRepository,
  knowledge: KnowledgeConfig,
): Promise<{ skills: BlobStore; memory: BlobStore }> {
  const { createGithubBlobStore } = await import('./adapters/github.ts');

  const build = (area: 'memory' | 'skills'): BlobStore =>
    createGithubBlobStore({
      repository,
      root: knowledgeRoot(knowledge, area),
      // What the commit says it did. Named per area rather than left to the
      // adapter's default, because "Store main/note.md" in a repository holding
      // both is a line that does not say which of them changed.
      message: (operation, key) =>
        `${operation === 'store' ? 'Store' : 'Remove'} ${area === 'skills' ? 'skill' : 'memory'} ${key}`,
    });

  return { skills: build('skills'), memory: build('memory') };
}

/** `github:owner/name#branch/path`, in one place so every reader agrees. */
export function describeKnowledge(knowledge: KnowledgeConfig): string {
  const branch = knowledge.branch ? `#${knowledge.branch}` : '';
  return `github:${knowledge.repo}${branch}${knowledge.path ? `/${knowledge.path}` : ''}`;
}
