import {
  WORKSPACE_FILE,
  listProfiles,
  workspaceFiles,
  type Config,
  type TargetConfig,
} from '#profile';
import { ConfigDocument, ensureSetupConnection, repairLines, repaired } from '#cli/config-edit.ts';
import { ok, print, style, warn } from '#cli/output.ts';

/**
 * What a deploy sends up, and the state it sends it in.
 *
 * Split out of `deploy.ts`, which had grown to hold two subjects: rolling a
 * revision, and the workspace that revision reads its config from. They meet at
 * one line in `deploy` and share nothing else — no state, no ordering beyond
 * "before the rollout" — and keeping them apart is what makes the pair of rules
 * below legible as a pair.
 *
 * Those rules are the reason this is a subject rather than a utility. Which
 * files go up is an allowlist, and which files get repaired on the way is
 * `listProfiles`, and the two must be scoped identically without being the same
 * question. Answering them forty lines apart, among rollout steps, is how they
 * drift.
 */

/**
 * The store URL a deployed instance reads its config from.
 *
 * The same bucket the target already declares — config sits beside state, the
 * log, memory and skills rather than in a place of its own. `undefined` for a
 * target on the filesystem adapter, which is not a thing anyone deploys but is
 * a thing `--dry-run` can be pointed at.
 */
export function deployedWorkspace(declared: TargetConfig): string | undefined {
  const { adapter, bucket, prefix } = declared.storage;
  if (adapter !== 'gcs' && adapter !== 's3') return undefined;
  if (!bucket) return undefined;

  return prefix ? `gs://${bucket}/${prefix.replace(/\/$/, '')}` : `gs://${bucket}`;
}

/**
 * What a deploy sends up: an allowlist, never a sync with exclusions.
 *
 * `data/` holds the encrypted credential store **and its key file**, and the
 * deployed target reads credentials from Secret Manager instead. Sending it
 * would put a decryptable credential document in a bucket — the exact thing
 * the `.dockerignore` exclusion exists to prevent, which is why that comment
 * calls itself load-bearing rather than an optimisation.
 *
 * An allowlist because the failure modes are not symmetric: a config file this
 * forgets means an endpoint that will not boot, and a credential this includes
 * by accident means a credential in a bucket. Forgetting is loud.
 */
export function isWorkspaceConfig(key: string, profile?: string | undefined): boolean {
  if (key === WORKSPACE_FILE) return true;
  if (key.startsWith('providers/') || key.startsWith('skills/')) return true;
  if (!key.startsWith('profiles/') || !key.endsWith('.yaml')) return false;

  // One profile when the deploy names one, so a workspace holding personal and
  // work does not push both into a bucket only one of them is for.
  return profile === undefined || key === `profiles/${profile}.yaml`;
}

/**
 * Give every profile about to be uploaded its setup surface.
 *
 * **Scoped exactly as the upload is**, because a profile this deploy sends is a
 * profile the endpoint will serve: repairing a narrower set would leave a served
 * profile without the surface, which is this bug one profile over. Note what
 * `flags.profile` does not mean — it is the flag alone, so a profile resolved
 * from `LANES_LINK_PROFILE` leaves it undefined and both this and the upload
 * read that as the whole workspace. Surprising, pre-existing in the upload, and
 * fixed there rather than here so the two cannot drift apart.
 *
 * *Which files are profiles* comes from `listProfiles`, never from
 * `isWorkspaceConfig`: the allowlist decides what is safe to *copy*, so it
 * happily sends a committed `personal.example.yaml` and a nested
 * `profiles/archive/old.yaml` as bytes, while this opens and validates what it
 * is handed — which turned that template into a `ConfigError` aborting the
 * deploy after provisioning had already made cloud resources.
 *
 * A profile that cannot be read is warned about rather than fatal: the repair is
 * a courtesy on the way past, and the upload still sends the file. Not silent,
 * though — nothing else here widens a policy without being asked.
 */
export async function repairSetupSurface(
  workspaceRoot: string,
  profile: string | undefined,
): Promise<void> {
  for (const name of await listProfiles(workspaceRoot)) {
    if (profile !== undefined && name !== profile) continue;

    try {
      const document = await ConfigDocument.open(workspaceRoot, name);
      const repair = ensureSetupConnection(document);
      if (!repaired(repair)) continue;

      await document.save();

      print(ok(`gave ${style.bold(name)} the setup surface`));
      for (const change of repairLines(repair)) print(`      ${style.dim(change)}`);
      print(`      ${style.dim('an agent can now see what is connected here, instead of guessing')}`);
    } catch (error) {
      print(
        warn(
          `could not give ${name} the setup surface: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        ),
      );
    }
  }
}

/**
 * Copy the workspace's config up.
 */
export async function uploadWorkspace(
  root: string,
  destination: string,
  profile: string | undefined,
): Promise<void> {
  const local = workspaceFiles(root);
  const remote = workspaceFiles(destination);

  let copied = 0;
  for (const entry of await local.list('')) {
    if (!isWorkspaceConfig(entry.key, profile)) continue;

    const bytes = await local.get(entry.key);
    if (bytes === null) continue;

    await remote.put(entry.key, bytes, { contentType: 'application/yaml' });
    copied += 1;
  }

  print(ok(`uploaded ${copied} config file${copied === 1 ? '' : 's'} to ${destination}`));
}

/**
 * Put the config where this target's endpoint reads it.
 *
 * Split from `deploy` because the two answer different questions. A deploy
 * asks "what should this revision run"; this asks "where does the config a
 * running endpoint reads actually live", and the answer stopped being "in the
 * image" at ADR-023. Once config lives in a bucket, copying it there is a
 * consequence of *editing* it, not of rolling a revision — which is what lets
 * `connect` stop ending in `lanes link deploy` (ADR-029).
 *
 * `null` when the target reads the same files the CLI just wrote: a local
 * target's endpoint opens the workspace directly, so there is nowhere to
 * publish to and nothing to copy.
 *
 * Scoped to the profile that was edited, deliberately more narrowly than
 * `deploy` scopes itself. `deploy` passes `flags.profile` — the flag alone —
 * so a profile resolved from `LANES_LINK_PROFILE` leaves it undefined and the
 * whole workspace goes up. An edit knows exactly which profile it touched, and
 * sending a sibling profile to a bucket because someone edited this one is a
 * surprise nobody asked for.
 */
export async function publishWorkspace(input: {
  readonly config: Config;
  readonly workspaceRoot: string;
  readonly target: string;
  readonly profile: string;
}): Promise<string | null> {
  const declared = input.config.targets[input.target];
  if (!declared) return null;

  const destination = deployedWorkspace(declared);
  if (!destination) return null;

  await uploadWorkspace(input.workspaceRoot, destination, input.profile);
  return destination;
}
