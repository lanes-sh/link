import type { ProviderManifest } from '#connectivity';
import { setupRequirements, type SetupRequirement } from '#connectivity';

/**
 * Whether what a provider requires is actually there.
 *
 * The requirements themselves are manifest-derived and live in
 * `#connectivity`, so the read-only setup capability can reach them. This
 * half needs the credential store and stays here: the MCP surface reports
 * what setup *requires*, and only the control plane reports what is
 * *satisfied* — ADR-007.
 */

/**
 * Of those, the ones not already in the store.
 *
 * CLI only. An MCP capability must never call this: reporting whether a
 * credential is present would make the read-only setup surface an oracle on the
 * credential store, which is the line ADR-007 draws. The surface says what is
 * required; only the control plane says what is satisfied.
 */
export async function missingRequirements(
  requirements: readonly SetupRequirement[],
  credentials: { has(ref: string): Promise<boolean> },
): Promise<SetupRequirement[]> {
  const missing: SetupRequirement[] = [];

  for (const requirement of requirements) {
    if (!(await credentials.has(requirement.ref))) missing.push(requirement);
  }

  return missing;
}

export type BlockedReason = 'needs_id' | 'needs_browser' | 'missing_credentials';

export interface Blocked {
  readonly reason: BlockedReason;
  readonly message: string;
  /** What to store first. Empty for the reasons that are not about a value. */
  readonly needs: readonly SetupRequirement[];
  /** The command to run once the above is done. */
  readonly then: string;
}

/**
 * Why a non-interactive `connect` cannot proceed, or `null` if it can.
 *
 * Every declared value is resolved here, before anything is written, so an
 * agent learns the whole list in one call rather than discovering it a prompt
 * at a time. That is the difference between one round trip and four.
 *
 * The OAuth case is a refusal rather than an attempt. `connect` would open a
 * browser and then block on a loopback listener for five minutes; an agent's
 * shell times out well before that, taking the listener with it, and the
 * operator is left with no token and nothing explaining why. A browser consent
 * belongs to whoever owns the browser, so we hand them the command instead.
 */
export async function preflight(input: {
  readonly manifest: ProviderManifest;
  readonly connectionId: string | undefined;
  readonly profile: string;
  readonly credentials: { has(ref: string): Promise<boolean> };
  /** How the operator spelled the target — `icloud`, or `gmail.main`. */
  readonly target: string;
}): Promise<Blocked | null> {
  const { manifest, connectionId, profile, target } = input;
  const rerun = `lanes link connect ${target} --profile ${profile}`;

  if (manifest.auth.kind === 'oauth') {
    return {
      reason: 'needs_browser',
      message:
        `${manifest.name} authorises in a browser, which needs the person whose account it is.\n` +
        `  Nothing was written. Run this in a terminal on the machine serving this endpoint:`,
      needs: [],
      then: rerun,
    };
  }

  const { requirements, needsId } = setupRequirements(manifest, connectionId, profile);

  if (needsId) {
    return {
      reason: 'needs_id',
      message:
        `${manifest.name} stores a credential per account, and the reference derives from the ` +
        `connection id — so it has to be named before anything can be stored under it.`,
      needs: requirements,
      then: `${rerun} --id <name> --non-interactive`,
    };
  }

  const missing = await missingRequirements(requirements, input.credentials);
  if (missing.length === 0) return null;

  return {
    reason: 'missing_credentials',
    message: `${manifest.name} needs ${missing.length} value(s) in the credential store first.`,
    needs: missing,
    then: `${rerun}${connectionId ? ` --id ${connectionId}` : ''} --non-interactive`,
  };
}
