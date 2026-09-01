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

export type BlockedReason =
  | 'needs_id'
  | 'needs_browser'
  /** A question only a person can answer, on a run with nobody to ask. */
  | 'needs_terminal'
  | 'missing_credentials'
  /**
   * The manifest itself is not settled yet — `connect custom` only.
   *
   * Unlike the others this is not about a credential: nothing has been written
   * and nothing needs storing first, the declaration is simply incomplete or
   * disagrees with the file already on disk. It shares `Blocked` because it
   * shares the thing that matters about one — every missing piece named at
   * once, and the command that ends it.
   */
  | 'needs_declaration';

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
  /** Which target's credential store the values have to be in. */
  readonly target: string;
  readonly credentials: { has(ref: string): Promise<boolean> };
  /**
   * How the operator spelled the provider — `icloud`, or `gmail.main`.
   *
   * Called `spec` and not `target`, which is what it was: this file holds the
   * only two meanings of that word in one scope, and the Lanes target is the one
   * that decides which credential store a suggested command writes into. A
   * transposition here produces a command that runs and stores a credential
   * somewhere nobody looks.
   */
  readonly spec: string;
  /**
   * Which way in the operator chose, for a provider offering two.
   *
   * The whole reason this parameter exists is that the OAuth refusal below is
   * about a *browser*, and the key route opens none. Without it a scripted
   * `connect --auth <key method>` would be turned away by a message describing
   * a step it does not perform.
   */
  readonly method?: 'oauth' | 'assertion' | 'pasted';
  /** What `--set` supplied, so an address given on the command line is not reported missing. */
  readonly supplied?: Readonly<Record<string, string>> | undefined;
}): Promise<Blocked | null> {
  const { manifest, connectionId, profile, target, spec } = input;
  const method = input.method ?? 'oauth';
  const rerun = `lanes link connect ${spec} --profile ${profile} --workspace ${target}`;
  const assertion = manifest.auth.kind === 'oauth' ? manifest.auth.assertion : undefined;

  if (method === 'assertion' && assertion) {
    // The key can be placed ahead of time; who it acts as cannot. That value
    // lives inside the pointer `connect` writes, so where it is mandatory this
    // run has a question and nobody to ask — and refusing here is better than
    // storing a credential that reads every mailbox as empty.
    if (assertion.delegation === 'required') {
      return {
        reason: 'needs_terminal',
        message:
          `${manifest.name} can only reach an account by acting as someone, and who that is has ` +
          `to be typed.\n  Nothing was written. Run this in a terminal:`,
        needs: [],
        then: `${rerun} --auth ${assertion.method}`,
      };
    }
  } else if (manifest.auth.kind === 'oauth' && method !== 'pasted') {
    // `pasted` opens no browser, so the refusal below does not describe it. It
    // needs a value instead, which *can* be placed ahead of time — so it falls
    // through to the requirement check and gets the `secrets set` line.
    return {
      reason: 'needs_browser',
      message:
        `${manifest.name} authorises in a browser, which needs the person whose account it is.\n` +
        `  Nothing was written. Run this in a terminal on the machine serving this endpoint:`,
      needs: [],
      then: rerun,
    };
  }

  const { requirements, needsId } = setupRequirements(
    manifest,
    connectionId,
    { profile, target },
    { method },
  );

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

  // Before the credential check, so the two come back together rather than one
  // per run. An address is not a credential and no `secrets set` places it —
  // `--set` does — but to somebody scripting this it is the same thing: another
  // value the command will refuse without. Reporting it only after the
  // credentials were stored made a two-step setup a three-step one.
  const address = manifest.variables
    .filter((variable) => (input.supplied ?? {})[variable.key] === undefined)
    .map((variable) => `--set ${variable.key}=${variable.example}`);

  const missing = await missingRequirements(requirements, input.credentials);
  if (missing.length === 0 && address.length === 0) return null;

  if (address.length > 0) {
    return {
      reason: 'missing_credentials',
      message:
        `${manifest.name} needs ${missing.length + address.length} value(s) before it can connect. ` +
        `Its address is not stored — it is given on the command line.`,
      needs: missing,
      then: `${rerun}${connectionId ? ` --id ${connectionId}` : ''} ${address.join(' ')} --non-interactive`,
    };
  }

  return {
    reason: 'missing_credentials',
    message: `${manifest.name} needs ${missing.length} value(s) in the credential store first.`,
    needs: missing,
    then:
      `${rerun}${connectionId ? ` --id ${connectionId}` : ''}` +
      `${method === 'assertion' && assertion ? ` --auth ${assertion.method}` : ''}` +
      `${method === 'pasted' ? ' --auth pasted_token' : ''} --non-interactive`,
  };
}
