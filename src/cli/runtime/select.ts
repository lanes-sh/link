import { generateProfileToken, ownerPrincipal } from '#auth';
import type { SecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';
import {
  loadProfileConfig,
  openTarget,
  readRegistry,
  resolveSelection,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
  requireTarget,
  type Config,
  type ProfileSelection,
  type ResolvedTarget,
  type Resolution,
} from '#profile';
import { openSecrets, openStorage } from '#deployments/target.ts';

/**
 * Which profile and target a command acts on, and the credentials that go with
 * them — everything that can be settled without opening a database.
 *
 * Kept apart from `./open.ts` because two callers need exactly this much and
 * nothing more: `secrets push` holds two targets open at once, and `deploy`
 * checks a cloud store only reachable from inside Google's
 * network. A full runtime would fail on the part neither of them uses.
 */

export interface GlobalFlags {
  readonly profile?: string | undefined;
  readonly target?: string | undefined;
  readonly quiet?: boolean;
}

export async function resolveProfile(
  flags: GlobalFlags,
  options: {
    /** `deploy` creates the target it is given; see `resolveTarget`. */
    allowUndeclaredTarget?: boolean;
    /** Injected by tests. Both resolutions must read the same one. */
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{
  resolution: Resolution;
  config: Config;
  target: string;
  /**
   * The adapter set, already followed to whichever workspace declares it.
   *
   * `undefined` only under `allowUndeclaredTarget`, which is `deploy` on a first
   * run: the target does not exist yet, so there is nothing to follow and
   * nothing to open. Every other caller can rely on it.
   */
  resolved: ResolvedTarget | undefined;
}> {
  // Spread rather than assigned: `exactOptionalPropertyTypes` makes an explicit
  // `env: undefined` a different type from an absent one, and the absent one is
  // what means "read the real environment".
  const env = options.env !== undefined ? { env: options.env } : {};

  // **Target first, and the order is the change.** It used to find the profile,
  // read its config, and ask that config which targets existed — which is why
  // "is `cloud` declared" had a different answer per profile, and why a profile
  // rewritten without its cloud block reported a running deployment as gone.
  //
  // A target is a workspace now (ADR-052), so it has to be resolved before there
  // is anywhere to look for a profile: `personal` on `local` and `personal` on
  // `cloud` are two files, in two workspaces, and only the target says which one
  // this command means.
  const localRoot = resolveWorkspaceRoot(env);
  const registry = await readRegistry(localRoot);
  const target = requireTarget(registry, flags.target, {
    allowUndeclared: options.allowUndeclaredTarget === true,
    root: localRoot,
  });

  // `deploy` on a first run names a target nothing declares yet, and there is no
  // workspace to follow. It resolves its own adapters from the flags it was
  // given; everything else follows the pointer here, once.
  const resolved = options.allowUndeclaredTarget === true && !(target in registry)
    ? undefined
    : await openTarget(localRoot, target);

  const root = resolved?.workspaceRoot ?? localRoot;
  const selection = await resolveSelection({ profileFlag: flags.profile, root, ...env });
  const { config } = await loadProfileConfig(root, selection.profile);

  return { resolution: { ...selection, target }, config, target, resolved };
}

/**
 * A profile, without opening any of its stores.
 *
 * `check` validates a YAML file, `config show` prints the whole of it, and
 * `policy list` reads a block that is the same wherever the profile runs. None
 * of them needs a credential store or a bucket, and opening one would make all
 * three fail on a target that is merely unreachable.
 *
 * It still needs `--target`, which it did not before. That is not ceremony: a
 * profile lives in exactly one target's workspace now (ADR-052), so without one
 * there is no file to validate — `personal` on `local` and `personal` on `cloud`
 * are different documents. What the flag buys here is finding the file; what it
 * still does not buy is opening anything.
 */
export async function resolveProfileOnly(
  flags: GlobalFlags,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<{ selection: ProfileSelection; config: Config; target: string }> {
  const env = options.env !== undefined ? { env: options.env } : {};
  const localRoot = resolveWorkspaceRoot(env);
  const registry = await readRegistry(localRoot);
  const target = requireTarget(registry, flags.target, { root: localRoot });
  const root = await resolveTargetWorkspace(localRoot, target);

  const selection = await resolveSelection({ profileFlag: flags.profile, root, ...env });
  const { config } = await loadProfileConfig(root, selection.profile);

  return { selection, config, target };
}

/**
 * One target's secret store, without opening its database.
 *
 * `secrets push` holds two targets open at once and touches neither state,
 * and `deploy` checks the cloud store while its Postgres is only reachable from
 * inside Google's network. Opening a full runtime for either would fail on the
 * part that is not needed.
 */
export async function openSecretStoreFor(
  config: Config,
  root: string,
  target: string,
): Promise<SecretStore> {
  // Resolved here rather than taken from the caller, so `secrets push --from
  // local --to cloud` can hold two targets that live in two different workspaces
  // without the caller having to follow either pointer itself.
  const resolved = await openTarget(root, target);
  return openSecrets({
    declared: resolved.declared,
    config,
    root: resolved.workspaceRoot,
    target,
  });
}

/**
 * One target's blob store, for a caller with no use for a runtime.
 *
 * The sibling of `openSecretStoreFor` above, and here for the reason this file
 * already gives: removal enumerates a target's objects and never dispatches a
 * call, so a registry and a reconcile would only add parts that can fail.
 *
 * `area` reaches a root other than the profile's own. The default is the
 * profile's blob tree; `profiles` is where a deployed revision reads its config
 * from (ADR-023), which lives outside that tree and still belongs to the
 * profile being removed.
 */
export async function openBlobStoreFor(
  config: Config,
  root: string,
  target: string,
  area?: string,
): Promise<BlobStore> {
  const resolved = await openTarget(root, target);

  const input = { declared: resolved.declared, config, root: resolved.workspaceRoot, target };
  const storage = await openStorage(input, await openSecrets(input));
  return area === undefined ? storage() : storage(area);
}

/** Mint the profile token if it does not exist yet. Returns it either way. */
export async function ensureProfileToken(
  credentials: SecretStore,
  tokenRef: string,
): Promise<{ token: string; created: boolean }> {
  const existing = await credentials.get(tokenRef);
  if (existing) return { token: existing, created: false };

  const token = generateProfileToken();
  await credentials.set(tokenRef, token);
  return { token, created: true };
}

export { ownerPrincipal };
