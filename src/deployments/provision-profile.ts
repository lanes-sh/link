import { openTarget, type TargetConfig } from '#profile';
import { heading, print, style } from '#cli/output.ts';
import { driverFor } from './drivers.ts';
import { readableRefs, rotatableRefs } from './prepare.ts';
import { printSteps, runSteps } from './steps.ts';
import type { DeployStep } from './driver.ts';

/**
 * Giving a profile what a *running* revision needs to open it, without rolling one.
 *
 * **Why this is not part of a deploy.** A revision reads a credential by
 * reference at request time — it is not baked into the image and not bound as an
 * env var — so what a profile created after the last rollout is missing is not
 * the revision, it is the secret container and the resource-level grant that
 * lets the runtime identity read it. Neither is a property of a revision, and
 * creating them takes no new one.
 *
 * What made this look like a redeploy is the shape of the failure. Secret
 * Manager answers a missing binding with 403 rather than 404, so that an
 * identity cannot enumerate secrets by their error codes — and the adapter
 * returns null for the 404 and *throws* for the 403
 * (`adapters/gcp-secret-manager.ts`). An unprovisioned ref is therefore a thrown
 * error on the open path, `openReconciled` skips the profile rather than failing
 * the endpoint for its siblings, and from outside it reads exactly like a
 * profile that does not exist. Bound, the same read becomes the 404 — a secret
 * with no version, which reads back as null and opens an empty vault. The grant
 * is what turns a crash into a value.
 *
 * So this is the half of `deploy` that a new profile actually needs, and
 * `deploy` runs the same steps for the same reason. Every one of them is written
 * to be run again (`isAlreadyThere` in `./steps.ts`), which is what makes it safe
 * to call on a profile whose siblings were provisioned long ago.
 */

/** What provisioning did, in a form a command can print without knowing a vendor. */
export interface ProvisionOutcome {
  /**
   * Whether the target needed provisioning at all.
   *
   * False for a target that declares no `deploy` block — a local one has no
   * runtime identity to grant anything to, and its secrets are a file this
   * machine already owns.
   */
  readonly applicable: boolean;
  /** How many steps ran. Zero is a target that was already complete. */
  readonly steps?: number;
  /** Why it could not run, in a form fit to print. Never thrown. */
  readonly reason?: string;
}

/**
 * The steps, as data.
 *
 * Split from running them because `deploy --dry-run` has to print this list
 * without touching a credential, and because a driver's whole contract is that
 * it returns steps rather than performing effects (`./driver.ts`). `deploy`
 * calls this and then decides whether to print or run; `provisionProfiles` below
 * is the same call for a command that only ever runs it.
 */
export async function provisionStepsFor(input: {
  readonly workspaceRoot: string;
  readonly target: string;
  readonly declared: TargetConfig;
  /**
   * Which profiles to walk. The target-level refs — the pairing token, the vault
   * key — are added by `readableRefs` whatever this says, so a one-profile call
   * still re-grants them, and re-granting is a no-op.
   */
  readonly profiles: readonly string[] | undefined;
}): Promise<DeployStep[]> {
  const deploy = input.declared.deploy;
  if (!deploy) return [];

  const driver = await driverFor(deploy.platform);
  const rotatable = await rotatableRefs(input.workspaceRoot, input.profiles, input.declared);
  const readable = await readableRefs(input.workspaceRoot, input.profiles, input.declared);

  return driver.provision({
    deploy,
    declared: input.declared,
    target: input.target,
    rotatable,
    readable,
    // Spread rather than passed, because `exactOptionalPropertyTypes` makes an
    // explicit `undefined` a different thing from an absent key — and here they
    // mean the same: walk every profile the workspace holds.
    ...(input.profiles !== undefined ? { profiles: input.profiles } : {}),
  });
}

/**
 * Build the steps and run them, for a command whose subject is not a rollout.
 *
 * **Never throws.** The caller is `profile add`, where the profile is already on
 * disk by the time this runs: a creation that succeeded must not report failure
 * because a cloud CLI is missing or an IAM call was refused. Everything that can
 * go wrong comes back as `reason` and is printed as a next step, which is the
 * same bargain `publishAndNotify` already makes with a notify that cannot land.
 */
export async function provisionProfiles(input: {
  readonly workspaceRoot: string;
  readonly target: string;
  readonly profiles: readonly string[];
}): Promise<ProvisionOutcome> {
  let declared: TargetConfig;
  try {
    ({ declared } = await openTarget(input.workspaceRoot, input.target));
  } catch (error) {
    return { applicable: false, reason: `could not read the target: ${message(error)}` };
  }

  const deploy = declared.deploy;
  if (!deploy) return { applicable: false };

  const driver = await driverFor(deploy.platform);

  // Before the steps are built, because building them reads IAM policy — a
  // network call that fails unhelpfully when the tool it shells out to is not
  // installed at all.
  const missing = driver.preflight();
  if (missing) return { applicable: true, reason: missing };

  let steps: DeployStep[];
  try {
    steps = await provisionStepsFor({ ...input, declared });
  } catch (error) {
    return { applicable: true, reason: `could not work out what to provision: ${message(error)}` };
  }

  if (steps.length === 0) return { applicable: true, steps: 0 };

  heading(`Provisioning for ${input.profiles.join(', ')} (${steps.length} steps)`);
  printSteps(driver, steps);
  print('');

  try {
    await runSteps(driver, steps);
  } catch (error) {
    return { applicable: true, reason: message(error) };
  }

  print(style.dim(`  ${steps.length} step(s) ran — no revision was rolled.`));
  return { applicable: true, steps: steps.length };
}

function message(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}
