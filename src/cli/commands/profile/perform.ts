import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import { fail, ok, print, style, warn } from '../../output.ts';
import type { RemovalItem, RemovalPlan } from './removal.ts';

/**
 * Performing a removal, and being honest about the parts that did not happen.
 *
 * Split from `remove.ts`, along the seam that file's own docstring had already
 * drawn: this sentence described the executor, the outcome and its exit code,
 * and nothing about the command that decides what to remove. `confirm.ts`
 * records the same split for the same reason — "not too long, two things".
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
  /**
   * What the plan could not name, because the config would not load.
   *
   * Carried through from `RemovalPlan.unreachable` so the exit code can account
   * for it — see `renderOutcome`.
   */
  readonly unreachable: readonly string[];
}

export interface RunDeps {
  openSecrets: (target: string) => Promise<SecretStore>;
  openBlobs: (target: string, area?: string) => Promise<BlobStore>;
  removeConfig: (path: string) => Promise<void>;
  /** The emptied profile directory. A blob delete cannot remove a directory. */
  removeDirectory: (path: string) => Promise<void>;
  clearDefaultProfile: () => Promise<void>;
  retry?: ((item: RemovalItem, cause: string) => string | undefined) | undefined;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The items that only make sense once everything else is actually gone.
 *
 * **`file` is in here, and that is the whole of its reason.** It is
 * `rm -rf profiles/<profile>`, and it carries a target rather than `null`, so
 * the original `target === null` test let it run after a failed object — taking
 * the bytes a `--migrate-to` had not managed to copy, and `profile.yaml`, which
 * the sweep deliberately leaves for last. `renderOutcome` then printed "the
 * profile's config was kept, so nothing is stranded" about a directory that no
 * longer existed. Same shape as the defect this file records having shipped
 * once already.
 */
const isRecordOfWhereThingsAre = (item: RemovalItem): boolean =>
  item.kind === 'file' ||
  (item.target === null && (item.kind === 'config' || item.kind === 'workspace-key'));

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

        case 'blob': {
          const store = await blobStore(item.target!, item.area);

          // Read across *before* deleting, and verify it landed — the same rule
          // the contract migrations follow, for the same reason: a copy that
          // half happened and a source that is already gone is the one state
          // with nothing to retry from. A collision was resolved while this was
          // still a plan, so the destination is free.
          if (item.movedTo !== undefined) {
            const [area, key] = item.movedTo;
            const bytes = await store.get(item.id);

            if (bytes !== null) {
              const into = await blobStore(item.target!, area);
              await into.put(key, bytes);
              if ((await into.get(key)) === null) {
                throw new Error(`${area}/${key} did not read back after being written`);
              }
            }
          }

          await store.delete(item.id);
          break;
        }

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
          await deps.removeDirectory(item.id);
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
    unreachable: plan.unreachable,
  };
}

/**
 * What happened, and what is still out there.
 *
 * The exit code is the load-bearing part. Best effort means the command can
 * finish having left a live credential behind, and to a script silence is
 * indistinguishable from success — so anything that survived makes this exit
 * non-zero, and names itself with the command that finishes it.
 *
 * **Exit 0 iff every item was removed *and* nothing was unreachable — not iff
 * the config parsed.** The contract above is "something is left", never
 * "something threw", and keying it on the parse would get both halves wrong at
 * once: the profile that #219 actually produces reads every field and leaves
 * nothing, so reporting failure for it would mean the fix did not fix the
 * cleanup script that hit this in the first place — and it would give that the
 * same code as a deployed profile that really did strand a sealed document.
 * Two states, one code, no information.
 */
export function renderOutcome(outcome: RemovalOutcome): void {
  const removed = outcome.results.filter((result) => result.status === 'removed');
  const failed = outcome.results.filter((result) => result.status === 'failed');
  const kept = outcome.results.filter((result) => result.status === 'kept');

  print();
  if (outcome.survived === 0 && outcome.unreachable.length === 0) {
    print(ok(`Removed profile ${style.bold(outcome.profile)} — ${removed.length} item(s).`));
    print();
    return;
  }

  // Nothing failed; what happened is that the config would not load and this
  // could not tell whether one of the refs it left behind was the profile's.
  //
  // **A separate sentence from the retry below, and it has to be.** That one
  // says "run the same command again", which works only because a failure keeps
  // the config — the record of where everything lives. Here the profile is gone
  // and there is nothing left to re-derive from, so the same advice would send
  // somebody to a command that can no longer help them.
  if (outcome.survived === 0) {
    print(
      warn(
        `Removed profile ${style.bold(outcome.profile)} — ${removed.length} item(s), from a ` +
          'config that would not load.',
      ),
    );
    print();
    print(`  ${style.bold('Not reachable, so not removed')}`);
    for (const line of outcome.unreachable) print(style.dim(`    ${line}`));
    print();
    print(
      'Running this again will not find them: the profile is gone. Delete them where they are, ' +
        'or leave them if they were never created.',
    );
    print();

    process.exitCode = 1;
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

/** The command that finishes a refusal by hand, where one can be named. */
export function retryCommand(item: RemovalItem): string | undefined {
  if (item.kind !== 'secret') return undefined;
  return `lanes link profile remove <name> --target ${item.target} # or delete ${item.id} in that store`;
}
