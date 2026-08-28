import { ConfigError } from '#profile';
import { print, style, waiting, warn } from '#cli/output.ts';
import type { DeployDriver, DeployStep } from './driver.ts';

/**
 * Running a driver's steps, and saying what happened to each.
 *
 * Split from `deploy.ts` because it is a different concern from the order those
 * steps go in: this is what "a step succeeded", "a step is already done" and "a
 * step is not ready yet" mean, and all three are decisions about a message
 * rather than about a deployment. Keeping them together pushed that file past
 * the size budget `src/architecture.test.ts` holds.
 */

export function printSteps(driver: DeployDriver, steps: readonly DeployStep[]): void {
  print('');
  for (const step of steps) {
    print(`  ${style.dim(step.title)}`);
    print(`    ${driver.tool} ${step.argv.join(' ')}`);
  }
}

/**
 * A failure that means "not yet" rather than "no".
 *
 * Enabling an API returns before the API is usable. The gap is seconds to a
 * couple of minutes, and inside it Google answers calls to that service with a
 * permission error rather than a "still starting" one — so the message an
 * operator gets is indistinguishable from having the wrong role, on a project
 * they own. This deploy enables seven APIs and then immediately uses all of
 * them, which makes it the most likely thing in the repository to land in that
 * window; a real deploy failed there, at the build, after uploading its source.
 *
 * `PERMISSION_DENIED` is genuinely ambiguous and is retried anyway. Waiting out
 * a bounded budget before reporting a real permission problem costs a minute;
 * failing a five-minute build because an API was enabled ninety seconds ago
 * costs the whole deploy and reads as a misconfiguration nobody has.
 */
const UNREADY =
  /SERVICE_DISABLED|has not been used in project|is not enabled|caller does not have permission|PERMISSION_DENIED/i;

/** Exported for its tests: which failures are worth waiting out. */
export function isUnready(stderr: string): boolean {
  return UNREADY.test(stderr);
}

/**
 * A failure that means the thing is already there.
 *
 * Every provisioning step is written to be run again, and on a second deploy all
 * of them are. Google reports that as an error — `ALREADY_EXISTS`, `409`, "is
 * the subject of a conflict", "you already own it" — and letting those through
 * meant a successful deploy printed a screen of red for the expected case, which
 * teaches an operator to skim past exactly the output that matters when
 * something is actually wrong.
 */
const EXISTS = /ALREADY_EXISTS|already exists|subject of a conflict|already own it|HTTPError 409/i;

export function isAlreadyThere(stderr: string): boolean {
  return EXISTS.test(stderr);
}

/**
 * The same thing, for a step that takes something away.
 *
 * A deploy removes the IAM bindings it supersedes, and a binding that is already
 * gone is that step succeeding: the second deploy after the one that removed it
 * finds nothing to remove, exactly as the second deploy after a create finds the
 * thing present. Without this it reads as a warning, and a successful deploy
 * printing warnings for its expected case teaches an operator to skim past the
 * output that matters.
 */
const GONE = /NOT_FOUND|not found|does not exist|no such|cannot find|HTTPError 404/i;

export function isAlreadyGone(stderr: string): boolean {
  return GONE.test(stderr);
}

/**
 * What a tolerated failure was, when it was this step's expected case.
 *
 * Keyed on what the step *does*, not on the message alone. `NOT_FOUND` from a
 * removal is the work already being done; the same word from a step that binds a
 * role means the secret it was binding does not exist, which is a deploy rolling
 * a revision that cannot read its own token — the failure that has to stay
 * visible.
 */
export function expectedOutcome(step: DeployStep, stderr: string): string | null {
  if (step.removes === true) return isAlreadyGone(stderr) ? 'already gone' : null;
  return isAlreadyThere(stderr) ? 'already there' : null;
}

/**
 * Spent across the whole run rather than per step.
 *
 * The wait is for one event — the APIs this deploy just enabled becoming usable
 * — so once any step has waited it out, the rest find them ready. A per-step
 * budget would multiply one propagation delay by the number of steps behind it,
 * and a deploy that can hang for a quarter of an hour is not more reliable than
 * one that fails.
 */
const PROPAGATION_BUDGET_MS = 150_000;
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 45_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSteps(
  driver: DeployDriver,
  steps: readonly DeployStep[],
  /** Injectable so a test can assert the retry without sleeping through it. */
  backoff: readonly number[] = BACKOFF_MS,
): Promise<void> {
  let budget = PROPAGATION_BUDGET_MS;

  for (const step of steps) {
    print('');
    print(style.dim(`  ${step.title}`));

    // A step that is allowed to have already happened is also one whose output
    // is a wall of IAM policy. Captured rather than streamed, so this decides
    // what to say about it — the long steps that need streaming are exactly the
    // ones that are not allowed to fail.
    const quiet = step.tolerateFailure === true;
    let result = await driver.run(step.argv, { quiet });

    for (const pause of backoff) {
      if (result.ok || budget < pause || !isUnready(result.stderr)) break;
      budget -= pause;

      await waiting(
        `not ready yet — an API this needs may have been enabled moments ago; retrying in ${Math.round(pause / 1000)}s`,
        () => sleep(pause),
      );
      result = await driver.run(step.argv, { quiet });
    }

    if (result.ok) {
      if (quiet) print(style.dim(`    ${style.green('+')} done`));
      continue;
    }

    if (step.tolerateFailure) {
      // The expected case on every deploy after the first, said as such.
      // Anything else it tolerated is still worth seeing, because a tolerated
      // failure that is not this step's expected case is how a deploy rolls a
      // revision with no service account and finds out several minutes later.
      const expected = expectedOutcome(step, result.stderr);
      print(
        expected !== null
          ? style.dim(`    ${style.green('=')} ${expected}`)
          : warn(`  ${firstLine(result.stderr)}`),
      );
      continue;
    }

    throw new ConfigError(`Deploy stopped: ${step.title} failed. ${result.stderr}`.trim());
  }
}

/** The line of a `gcloud` failure that says what went wrong, without the trace. */
function firstLine(stderr: string): string {
  return (
    stderr
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('ERROR:') || line.length > 0) ?? 'failed with no message'
  );
}
