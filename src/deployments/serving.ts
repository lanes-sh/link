import {
  readConnections,
  ConfigError,
  listProfiles,
  loadWorkspaceProfiles,
  readRegistry,
  type WorkspaceProfiles,
} from '#profile';
import { rotatableCredentialRefsFor } from '#registry';
import { buildRegistryWithWorkspace } from '#cli/runtime.ts';

/**
 * Which profiles a deploy sends, and whether they can share one place.
 *
 * `deploy` used to send the profile it was told and no other. That reads as the
 * safe default and is not what the thing being deployed does: one endpoint
 * serves *every* profile in the bucket (ADR-009), so a workspace with two
 * profiles needed two deploys, and the second one had to be told a target the
 * profile did not declare yet — which the survey then offered to create
 * somewhere new. The way to deploy both was to know that already.
 *
 * The set is derived rather than guessed: it is every profile *in* the target's
 * workspace, which is exactly the set the endpoint will try to open. `--profile`
 * narrows it, and naming one is still how a first deploy works, because a target
 * that does not exist yet has no workspace to derive from (ADR-043, ADR-052).
 *
 * It used to be "every profile declaring the target", read out of each profile's
 * own file. That is the shape ADR-052 removed: the same question had a different
 * answer per profile, so a rewritten file could drop a profile out of the set
 * silently and the deploy would quietly send fewer profiles than the endpoint
 * was serving.
 */

export interface Serving {
  /** Every profile this deploy will upload. Never empty. */
  readonly profiles: string[];
  /** Whose token opens the endpoint, and what the revision is told it is. */
  readonly primary: string;
}

export async function servingProfiles(input: {
  readonly workspaceRoot: string;
  readonly target: string;
  /** What `--profile` named, in order. Empty when it named nothing. */
  readonly named: readonly string[];
}): Promise<Serving> {
  const { workspaceRoot, target, named } = input;

  if (named.length > 0) {
    return { profiles: [...named], primary: named[0]! };
  }

  const living = await listProfiles(workspaceRoot);

  if (living.length === 0) {
    throw new ConfigError(
      `No profile lives in "${target}", so there is no set to deploy.\n` +
        '  A first deploy creates the target, and has to be told which profile\n' +
        '  it belongs to:\n' +
        `    lanes link deploy --workspace ${target} --profile <name>\n\n` +
        `  If "${target}" was deployed before and the pointer to it was lost:\n` +
        `    lanes link sync targets --workspace ${target} --discover`,
    );
  }

  return { profiles: living, primary: await choosePrimary(workspaceRoot, target, living) };
}

/**
 * Whose bearer token opens the endpoint.
 *
 * One endpoint, one token, every profile behind it (ADR-009) — so this decides
 * who gets in, and it is the one thing about a deployment that must not be
 * inferred from whatever happens to sort first. Recorded by the last deploy
 * when there was one; otherwise there has to be exactly one candidate, or the
 * operator is asked.
 */
async function choosePrimary(
  workspaceRoot: string,
  target: string,
  declaring: readonly string[],
): Promise<string> {
  const recorded = (await readRegistry(workspaceRoot))[target]?.primary;
  if (recorded !== undefined && declaring.includes(recorded)) return recorded;

  if (declaring.length === 1) return declaring[0]!;

  throw new ConfigError(
    `${declaring.length} profiles live in "${target}", and nothing records which\n` +
      "of them owns the endpoint's token. One token opens the endpoint and\n" +
      'reaches every profile behind it, so this cannot be picked for you.\n\n' +
      `  Name it once and it is remembered:\n` +
      `    lanes link deploy --workspace ${target} --profile ${declaring[0]!}` +
      declaring
        .slice(1)
        .map((name) => ` --profile ${name}`)
        .join(''),
  );
}

