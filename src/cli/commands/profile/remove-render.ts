import { fail, ok, print, style } from '../../output.ts';
import type { RemovalOutcome } from './remove.ts';

/**
 * How a removal reads in a terminal.
 *
 * Split from `./remove.ts` when that file crossed the budget, along the seam it
 * already had: what a removal *does* is a different subject from what it *looks
 * like*, and only one of them has an opinion about colour. The same cut
 * `pair-certificate.ts` took out of `pair.ts`.
 */

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
