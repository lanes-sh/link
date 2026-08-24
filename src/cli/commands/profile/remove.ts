import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { ConfigError } from '#profile';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { fail, ok, print, style } from '../../output.ts';
import type { RemovalItem, RemovalPlan } from './removal.ts';

/**
 * Performing a removal, and being honest about the parts that did not happen.
 *
 * Best effort by choice: a target whose project has been deleted must not be
 * able to strand a profile on the machine forever, so one refusal does not stop
 * the rest. The price is real — a deletion that fails leaves a live credential
 * behind — and everything here exists to make that visible rather than quiet.
 */

export interface RemovalResult {
  readonly item: RemovalItem;
  /** `kept` is deliberate: not attempted, because something before it failed. */
  readonly status: 'removed' | 'failed' | 'kept';
  readonly error?: string;
  /** The exact command that finishes this one by hand. */
  readonly retry?: string;
}

export interface RemovalOutcome {
  readonly profile: string;
  readonly results: readonly RemovalResult[];
  /** How many items are still there. Non-zero means a credential is still live. */
  readonly survived: number;
}

export interface RunDeps {
  openSecrets: (target: string) => Promise<SecretStore>;
  openBlobs: (target: string, area?: string) => Promise<BlobStore>;
  removeConfig: (path: string) => Promise<void>;
  clearDefaultProfile: () => Promise<void>;
  retry?: ((item: RemovalItem, cause: string) => string | undefined) | undefined;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The items that only make sense once everything else is actually gone. */
const isRecordOfWhereThingsAre = (item: RemovalItem): boolean =>
  item.target === null && (item.kind === 'config' || item.kind === 'workspace-key');

export async function executeRemoval(
  plan: RemovalPlan,
  deps: RunDeps,
): Promise<RemovalOutcome> {
  const results: RemovalResult[] = [];
  let failed = 0;

  // One store per target, however many items it holds. Opening a Secret
  // Manager client per secret would turn a tidy removal into a rate limit.
  const secrets = new Map<string, Promise<SecretStore>>();
  const blobs = new Map<string, Promise<BlobStore>>();

  const secretStore = (target: string): Promise<SecretStore> => {
    const existing = secrets.get(target) ?? deps.openSecrets(target);
    secrets.set(target, existing);
    return existing;
  };

  const blobStore = (target: string, area?: string): Promise<BlobStore> => {
    const key = `${target}:${area ?? ''}`;
    const existing = blobs.get(key) ?? deps.openBlobs(target, area);
    blobs.set(key, existing);
    return existing;
  };

  for (const item of plan.items) {
    // The config is the only record of where everything else lives. Deleting it
    // after a failure would strand precisely the credential that failed: still
    // live, and nothing left that knows where it is. Keeping it means the retry
    // is this same command rather than a hand-assembled console session.
    if (failed > 0 && isRecordOfWhereThingsAre(item)) {
      results.push({ item, status: 'kept' });
      continue;
    }

    try {
      switch (item.kind) {
        case 'secret':
          await (await secretStore(item.target!)).delete(item.id);
          break;

        case 'blob':
          await (await blobStore(item.target!)).delete(item.id);
          break;

        case 'config':
          if (item.target === null) await deps.removeConfig(item.id);
          else {
            // `profiles/<name>.yaml` in the target's bucket — outside the
            // profile's blob tree, so it needs its own area.
            const [area, ...rest] = item.id.split('/');
            await (await blobStore(item.target, area)).delete(rest.join('/'));
          }
          break;

        case 'workspace-key':
          await deps.clearDefaultProfile();
          break;

        case 'file':
          await deps.removeConfig(item.id);
          break;
      }

      results.push({ item, status: 'removed' });
    } catch (cause) {
      const error = reason(cause);
      const retry = deps.retry?.(item, error);
      failed += 1;
      results.push({ item, status: 'failed', error, ...(retry ? { retry } : {}) });
    }
  }

  return {
    profile: plan.profile,
    results,
    survived: results.filter((result) => result.status !== 'removed').length,
  };
}

/**
 * What happened, and what is still out there.
 *
 * The exit code is the load-bearing part. Best effort means the command can
 * finish having left a live credential behind, and to a script silence is
 * indistinguishable from success — so anything that survived makes this exit
 * non-zero, and names itself with the command that finishes it.
 */
export function renderOutcome(outcome: RemovalOutcome): void {
  const removed = outcome.results.filter((result) => result.status === 'removed');
  const failed = outcome.results.filter((result) => result.status === 'failed');
  const kept = outcome.results.filter((result) => result.status === 'kept');

  print();
  if (outcome.survived === 0) {
    print(ok(`Removed profile ${style.bold(outcome.profile)} — ${removed.length} item(s).`));
    print();
    return;
  }

  print(
    fail(
      `Removed ${removed.length} item(s) of profile ${style.bold(outcome.profile)}, and ${failed.length} refused.`,
    ),
  );
  print();

  for (const result of failed) {
    print(`  ${result.item.id}`);
    if (result.error) print(style.dim(`    ${result.error}`));
    if (result.retry) print(style.dim(`    finish it with: ${result.retry}`));
  }
  print();

  if (kept.length > 0) {
    // Said plainly, because the alternative reading — that the profile is
    // half-gone and needs unpicking by hand — is the one an operator will
    // assume from a failure report.
    print(
      `The profile's config was kept, so nothing is stranded: fix the above and run the same command again.`,
    );
    print();
  }

  // A live credential left behind must not look like success to a script.
  process.exitCode = 1;
}

/**
 * The confirmation, which asks for the name rather than a keystroke.
 *
 * A step up from `agreed()`, deliberately. That helper is `y/N` and is right
 * for `vault remove`, which drops one item the operator can put back. This
 * drops every live OAuth refresh token a profile holds, and putting those back
 * means visiting each vendor again — so the gesture should be one you cannot
 * make by leaning on the keyboard.
 *
 * Local rather than shared for the same reason it is not `agreed()`: the shape
 * differs, and bending the existing helper for a single caller in another
 * command folder would leave both worse. If a second consumer appears, promote
 * it then.
 */
export async function confirmedByName(
  profile: string,
  options: { yes?: boolean | undefined; prompter?: Prompter | undefined },
): Promise<boolean> {
  if (options.yes) return true;

  // A prompter that was passed in is the caller's answer to "is there anyone
  // to ask" — the console passes one that replays a form. Only the default
  // needs stdin consulted, and conflating the two makes an injected prompter
  // untestable and a real terminal the only place this works.
  const prompter = options.prompter ?? terminalPrompter;
  const someoneToAsk = options.prompter ? prompter.interactive : process.stdin.isTTY;

  if (!someoneToAsk) {
    throw new ConfigError(
      `Removing "${profile}" cannot be undone, and stdin is not a terminal, so there is nobody to ask. Pass --yes to proceed.`,
    );
  }

  const typed = (await prompter.ask(`Type ${profile} to remove it, or anything else to stop: `))
    .trim();

  if (typed !== profile) {
    print(style.dim('  cancelled — nothing was removed'));
    return false;
  }
  return true;
}
