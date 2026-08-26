import type { Config, Resolution } from '#profile';
import { announce, print, style, warn } from '../../output.ts';

/**
 * The line `connect` prints before it acts, and the one case it warns about.
 *
 * The sibling of `outcome.ts`, split from the orchestration for the reason that
 * file's header already gives: the five steps are about vendors and credentials,
 * this is about what a caller is told. It buys the same thing too — neither
 * function needs a runtime, a config file, or a credential store to be tested,
 * which is what makes the wording checkable at all.
 *
 * `connect` was the only mutating command that never said which target it wrote
 * to, and the only one that writes a credential to a real store. A profile whose
 * `instance.default_target` is still `local` after a deploy takes the account
 * into the local file, and the deployed endpoint goes on refusing it — with
 * nothing printed that would let anyone notice. `docs/deploy.md` already claimed
 * "every command prints which target it resolved and where that came from"; this
 * is the file that makes that true.
 */

/**
 * Say where this is going, unless the caller wants JSON.
 *
 * The guard is here rather than at the call site so the announce and the warning
 * cannot drift apart on the question. `emit`'s early return only protects lines
 * printed *at* the emit, and this one has to precede the browser — so it needs
 * the guard `audit.ts` and `owner/shared.ts` already use, for the reason
 * `output.ts` gives beside `emit`: a line of prose in front of a JSON document
 * corrupts it for whatever is parsing.
 */
export function announceConnectTarget(
  runtime: { readonly resolution: Resolution; readonly config: Pick<Config, 'targets'> },
  spec: string,
  json?: boolean | undefined,
): void {
  if (json === true) return;

  announce(runtime.resolution);

  const gap = deploymentGap(runtime.resolution, runtime.config.targets, spec);
  if (!gap) return;

  print();
  for (const line of gap) print(line);
}

/**
 * The warning for an account about to land somewhere the deployment cannot read.
 *
 * Returns lines rather than printing them: an array is something a test can
 * assert on without capturing stdout, and it leaves the wording reusable.
 *
 * Three conditions, and the third is the one worth defending. `target.ts` states
 * the house rule for a conditional line — print it only when the two disagree,
 * because saying it every time trains people to stop reading it. `--target local`
 * typed on this very command line is the operator saying it in the same breath,
 * and the announce directly above already echoes `target local (flag)` back at
 * them. What is left is exactly the two silent sources: `config-default`, which
 * is the case this exists for, and `environment`, which `Resolution` calls the
 * one an operator is most likely to be surprised by.
 *
 * "Declares a deployment", never "is deployed". Knowing a target is genuinely
 * deployed means asking the platform — a `gcloud` subprocess on the path of
 * every `connect`, a cost `target list` already refuses for a listing. The free
 * signal is the `deploy` block, so the wording is held to what that proves.
 */
export function deploymentGap(
  resolution: Pick<Resolution, 'target' | 'targetSource'>,
  targets: Config['targets'],
  spec: string,
): readonly string[] | null {
  if (targets[resolution.target]?.deploy !== undefined) return null;
  if (resolution.targetSource === 'flag') return null;

  const deployed = Object.entries(targets)
    .filter(([, declared]) => declared.deploy !== undefined)
    .map(([name]) => name);

  if (deployed.length === 0) return null;

  const here = resolution.target;
  // Named rather than picked, matching `resolveDeployTarget`, which throws on
  // this ambiguity instead of taking whichever came first in a YAML mapping. A
  // printed line should not be less careful than the resolver.
  const named = deployed.length === 1 ? deployed[0] : `<one of: ${deployed.join(', ')}>`;

  return [
    warn(
      `"${here}" declares no deployment; this profile declares ` +
        `${deployed.length === 1 ? `"${deployed[0]}"` : deployed.map((name) => `"${name}"`).join(' and ')}, which does.`,
    ),
    style.dim(`      The account goes into ${here}'s credential store, so the deployed endpoint`),
    style.dim('      will not see it. To put it there instead:'),
    style.dim(`        lanes link connect ${spec} --target ${named}`),
  ];
}
