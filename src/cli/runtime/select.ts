import { ownerPrincipal } from '#auth';
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
  type LoadedConfig,
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
  const found = await locateProfile(flags, options);
  if (found.loaded === null) throw found.refusal;

  return { selection: found.selection, config: found.loaded.config, target: found.target };
}

/**
 * The profile that was named, and the config only if it would load.
 *
 * `resolveProfileOnly` above is this plus a rethrow, and that is the whole
 * point: one resolution path, so the caller that has to survive a config which
 * will not parse cannot drift from the eight that do not.
 *
 * **It exists because catching around `resolveProfileOnly` is not safe.**
 * `ConfigError` comes out of that call for a missing `--workspace`, a target
 * the registry does not declare, a pointer chain that will not follow, a
 * contract-3 layout, and a profile that is simply not there — as well as for
 * the parse. A `try` around the whole thing would read "you typed the wrong
 * workspace" as "this profile is broken", and `profile remove --yes
 * --delete-data` would then run a removal to completion in a workspace nobody
 * meant. Everything up to and including `resolveSelection` therefore still
 * throws exactly as it did; only the parse is caught, and only here.
 *
 * `resolveSelection` never reads a profile's config — it asks the workspace
 * whether the file exists — which is the property that makes this split
 * possible at all, and the same one `migratedRenamedProviders` relies on.
 *
 * `refusal` is `unknown` so it can be rethrown verbatim: a `ConfigError`
 * carries `findings`, and re-wrapping it would drop them.
 */
export type LocatedProfile =
  | {
      readonly selection: ProfileSelection;
      readonly target: string;
      readonly loaded: LoadedConfig;
    }
  | {
      readonly selection: ProfileSelection;
      readonly target: string;
      readonly loaded: null;
      readonly refusal: unknown;
    };

export async function locateProfile(
  flags: GlobalFlags,
  options: { env?: Record<string, string | undefined> } = {},
): Promise<LocatedProfile> {
  const env = options.env !== undefined ? { env: options.env } : {};
  const localRoot = resolveWorkspaceRoot(env);
  const registry = await readRegistry(localRoot);
  const target = requireTarget(registry, flags.target, { root: localRoot });
  const root = await resolveTargetWorkspace(localRoot, target);

  const selection = await resolveSelection({ profileFlag: flags.profile, root, ...env });

  try {
    return { selection, target, loaded: await loadProfileConfig(root, selection.profile) };
  } catch (refusal) {
    return { selection, target, loaded: null, refusal };
  }
}

/**
 * One target's secret store, without opening its database.
 *
 * `secrets push` holds two targets open at once and touches neither state,
 * and `deploy` checks the cloud store while its Postgres is only reachable from
 * inside Google's network. Opening a full runtime for either would fail on the
 * part that is not needed.
 */
export async function openSecretStoreFor(root: string, target: string): Promise<SecretStore> {
  // Resolved here rather than taken from the caller, so `secrets push --from
  // local --to cloud` can hold two targets that live in two different workspaces
  // without the caller having to follow either pointer itself.
  const resolved = await openTarget(root, target);
  return openSecrets({ declared: resolved.declared, root: resolved.workspaceRoot, target });
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
 *
 * **A name, not the config it is written in.** The name is the whole of what
 * reaches the store — `layout.blobs(profile)` is the default area and nothing
 * else was ever read — and taking a `Config` for it meant a removal could not
 * open the stores of the one profile it most needs to: the one whose config
 * will not parse (#219). `openSecrets` above was narrowed for the same reason
 * and says so; this is that argument applied to the other store.
 */
export async function openBlobStoreFor(
  profile: string,
  root: string,
  target: string,
  area?: string,
): Promise<BlobStore> {
  const resolved = await openTarget(root, target);

  const input = { declared: resolved.declared, profile, root: resolved.workspaceRoot, target };
  const storage = await openStorage(input, await openSecrets(input));
  return area === undefined ? storage() : storage(area);
}


export { ownerPrincipal };
