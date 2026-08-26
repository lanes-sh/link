import type { Config, Resolution } from '#profile';
import { announce } from '../../output.ts';

/**
 * The line `connect` prints before it acts.
 *
 * Split from the five steps for the reason `outcome.ts` gives: the orchestration
 * is about vendors and credentials, this is about what a caller is told. It buys
 * the same thing too — no runtime, no config file and no credential store are
 * needed to check that the line appears and that `--json` stays parseable.
 *
 * `connect` was the only mutating command that never said which target it wrote
 * to, and the only one that writes a credential into a real store.
 *
 * This file also *held* a warning, for the case where a bare `connect` resolved
 * to a local target while the profile declared a deployed one. ADR-037 removed
 * the case rather than the warning: a target is named on the command line or the
 * command does not run, so there is no longer a selection the operator did not
 * make. What replaced it sits one step earlier — `deployments/servable.ts`
 * refuses a *deploy* that would send a profile the revision cannot open, which
 * is the same mistake caught where it is still cheap.
 */
export function announceConnectTarget(
  runtime: { readonly resolution: Resolution; readonly config: Pick<Config, 'targets'> },
  json?: boolean | undefined,
): void {
  // `emit`'s early return only protects lines printed *at* the emit, and this
  // one has to precede the browser — so it carries its own guard, the one
  // `audit.ts` and `owner/shared.ts` already use. `output.ts` gives the reason
  // beside `emit`: a line of prose in front of a JSON document corrupts it.
  if (json === true) return;

  announce(runtime.resolution);
}
