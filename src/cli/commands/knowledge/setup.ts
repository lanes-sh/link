import { ConfigError, type KnowledgeConfig } from '#profile';
import type { SecretStore } from '#secrets';
import { GithubRepository, type RepositoryFacts } from '#deployments/adapters/github-repo.ts';
import type { FetchLike } from '#deployments/knowledge.ts';
import { heading, print, style } from '../../output.ts';
import { askSecret, isInteractive } from '../../prompt.ts';

/**
 * Getting a token, and finding out whether the repository is a sane place to
 * put somebody's memory.
 *
 * Both halves happen **before** anything is written — no config edit, no
 * commit, no local deletion. A half-switched profile is the worst outcome
 * available here: the config says one thing, the bytes are somewhere else, and
 * the failure looks like an empty memory rather than like an error.
 */

/**
 * The steps, shown when there is no token yet.
 *
 * The same shape as `src/providers/github/index.ts`'s `setup.steps`, and
 * deliberately not the same token. That one talks to GitHub's MCP server and
 * needs Contents **read**; this one writes and needs Contents **write**. Two
 * permissions, two lifetimes, and two things to revoke separately — revoking
 * an MCP connection must not quietly empty somebody's memory.
 */
const STEPS = [
  'Create a repository for this, or pick one you already have. **Make it private** — memory entries are yours.',
  'Open https://github.com/settings/personal-access-tokens and choose "Generate new token".',
  'Name it "Lanes Link knowledge" — the name is how you revoke this one later without touching your other tokens — and set an expiry you are willing to renew.',
  'Resource owner: yourself, or the organisation that owns the repository. An organisation may require an owner to approve the token before it works.',
  'Repository access: **only** the one repository this will store in.',
  'Permissions: Contents (read and write), Metadata (read, added for you). Nothing else is needed.',
  'Generate, then copy the token. GitHub shows it once, and it starts with github_pat_.',
];

export function printSetupSteps(repo: string): void {
  heading('A token for this repository');
  print(style.dim(`  Storing memory and skills in ${repo} needs a token that may write to it.`));
  print('');
  for (const [index, step] of STEPS.entries()) {
    print(`  ${style.dim(`${index + 1}.`)} ${step.replace(/\*\*(.+?)\*\*/g, (_, inner: string) => style.bold(inner))}`);
  }
  print('');
}

/**
 * The token this profile will use, asked for only when it is not already
 * stored.
 *
 * Read from a terminal without echo, or from stdin when there is no terminal —
 * never from argv, which lands in shell history and in `ps` output while the
 * command runs. The same rule `lanes link secrets set` states and for the same
 * reasons.
 */
export async function resolveToken(
  secrets: SecretStore,
  ref: string,
  repo: string,
  /** `--profile x --target y`, so the command in the refusal is one that runs. */
  selection: string,
  options: { replace?: boolean | undefined } = {},
): Promise<string> {
  if (!options.replace) {
    const stored = await secrets.get(ref);
    if (stored) return stored;
  }

  if (!process.stdin.isTTY) {
    const piped = (await Bun.stdin.text()).trim();
    if (piped) return piped;

    throw new ConfigError(
      `No token stored at "${ref}", and stdin is a terminal-less pipe with nothing in it.\n` +
        `  printf %s "<github_pat_…>" | lanes link knowledge use github --repo ${repo}${selection}\n` +
        '  Pass it this way rather than as an argument: an argument is in your shell history.',
    );
  }

  if (!isInteractive()) {
    throw new ConfigError(`No token stored at "${ref}", and there is nobody to ask for one.`);
  }

  printSetupSteps(repo);
  const token = await askSecret('  GitHub personal access token');
  if (!token) throw new ConfigError('No token given, so nothing was changed.');
  return token;
}

/**
 * What the repository is, and whether this is somewhere memory may go.
 *
 * Three refusals, and the first is the one worth the flag. A public repository
 * is a working store and a catastrophic one: every entry the owner has written,
 * and every procedure naming their accounts and their colleagues, world-readable
 * and indexed. It is refused rather than warned about, because a warning during
 * a migration is read after the migration.
 */
export async function probe(
  repository: GithubRepository,
  options: { allowPublic?: boolean | undefined },
): Promise<{ facts: RepositoryFacts; viewer: string }> {
  const viewer = await repository.viewer();
  const facts = await repository.facts();

  if (!facts.canPush) {
    throw new ConfigError(
      `The token can read ${facts.fullName} but not write to it. Memory and skills are written, ` +
        'not just read, so this needs Contents: read and write.\n' +
        '  Regenerate at https://github.com/settings/personal-access-tokens, then run this again.',
    );
  }

  if (!facts.private && options.allowPublic !== true) {
    throw new ConfigError(
      `${facts.fullName} is public. Memory entries are the owner's own notes and a skill names ` +
        'the accounts and people it operates on — a public repository publishes both, permanently ' +
        'and searchably.\n' +
        '  Make it private, or pass --allow-public if you genuinely mean to publish them.',
    );
  }

  return { facts, viewer };
}

/**
 * A client for a repository, built from what the command was told.
 *
 * The one construction point in this command, so `use github` and `use local`
 * cannot end up talking to different clients — and so a test has one thing to
 * hand a `fetch` to.
 */
export function repositoryFor(
  knowledge: KnowledgeConfig,
  token: string,
  call?: FetchLike,
): GithubRepository {
  return new GithubRepository({
    repo: knowledge.repo,
    token,
    ...(knowledge.branch !== undefined ? { branch: knowledge.branch } : {}),
    ...(call ? { fetch: call } : {}),
  });
}
