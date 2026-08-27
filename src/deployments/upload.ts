import {
  openTarget,
  DATA_DIR,
  WORKSPACE_FILE,
  layout,
  listProfiles,
  workspaceFiles,
  type Config,
  type TargetConfig,
} from '#profile';
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
 *
 * **Two areas inside `data/` are authored rather than accumulated**, since
 * ADR-030 moved skills and provider manifests into the profile that owns them.
 * They have to go up or a deployed instance loses both — the regression ADR-014
 * §2 fixed for skills, reintroduced by where they now live. So this reaches
 * into `data/` for exactly those two, by whole path segment and never by
 * prefix: `data/personal/skills.detour/` is not `skills.d`, and the difference
 * between matching it and not is a credential in a bucket.
 */
export function isWorkspaceConfig(key: string, profiles?: readonly string[]): boolean {
  // **Never the workspace file.** It was sent, and it is the one file that must
  // not be: it holds the *target registry*, and the two workspaces have
  // different ones. This machine's says `cloud: workspace: gs://…`, so copying
  // it into that bucket left the bucket pointing at itself — a loop `openTarget`
  // refuses, on the target it had just deployed (ADR-052).
  //
  // The bucket's own registry is written by `deploy`, from the declaration, once
  // the upload is done.
  if (key === WORKSPACE_FILE) return false;

  // A set rather than one name, because a deploy now sends every profile that
  // declares the target rather than the single one it was told. `undefined`
  // still means the whole workspace, and an *empty* set means nothing — which
  // is a distinction a bare string could not make.
  const wanted = profiles === undefined ? undefined : new Set(profiles);

  const owner = authoredAreaOwner(key);
  if (owner !== null) return wanted === undefined || wanted.has(owner);

  if (!key.startsWith('profiles/') || !key.endsWith('.yaml')) return false;
  const name = key.slice('profiles/'.length, -'.yaml'.length);
  return wanted === undefined || wanted.has(name);
}

/**
 * The profile whose authored area holds `key`, or null for anything else.
 *
 * Composed back out of `layout` rather than compared against literals, so a
 * renamed directory moves both this and the store that reads it, or neither.
 * Requires a fourth segment: `data/personal/skills.d` names the directory, and
 * a directory is not a file to send.
 */
function authoredAreaOwner(key: string): string | null {
  const segments = key.split('/');
  if (segments.length < 4 || segments[0] !== DATA_DIR) return null;

  const owner = segments[1]!;
  if (owner.length === 0) return null;

  const area = `${DATA_DIR}/${owner}/${segments[2]}`;
  return area === layout.skills(owner) || area === layout.providers(owner) ? owner : null;
}

/**
 * Copy the workspace's config up.
 */
export async function uploadWorkspace(
  root: string,
  destination: string,
  profiles: readonly string[] | undefined,
): Promise<void> {
  const local = workspaceFiles(root);
  const remote = workspaceFiles(destination);

  let copied = 0;
  for (const entry of await local.list('')) {
    if (!isWorkspaceConfig(entry.key, profiles)) continue;

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
  // Resolution failures are swallowed rather than thrown. The config edit that
  // called this has already succeeded and is on disk; a target that cannot be
  // resolved — undeclared, or a pointer to a bucket that is not answering — is
  // something for `check` and `status` to report, not a reason to fail an edit
  // that is done. Returning null is "published nowhere", which is exactly what
  // happened.
  const declared = await openTarget(input.workspaceRoot, input.target)
    .then((resolved) => resolved.declared)
    .catch(() => undefined);
  if (!declared) return null;

  const destination = deployedWorkspace(declared);
  if (!destination) return null;

  await uploadWorkspace(input.workspaceRoot, destination, [input.profile]);
  return destination;
}
