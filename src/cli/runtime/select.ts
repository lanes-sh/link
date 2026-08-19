import { generateProfileToken, ownerPrincipal } from '#auth';
import type { SecretStore } from '#secrets';
import {
  loadProfileConfig,
  resolveSelection,
  resolveTarget,
  undeclaredTarget,
  type Config,
  type Resolution,
} from '#profile';
import { openSecrets } from '#deployments/target.ts';

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
}> {
  // Spread rather than assigned: `exactOptionalPropertyTypes` makes an explicit
  // `env: undefined` a different type from an absent one, and the absent one is
  // what means "read the real environment".
  const env = options.env !== undefined ? { env: options.env } : {};

  const selection = await resolveSelection({
    profileFlag: flags.profile,
    targetFlag: flags.target,
    ...env,
  });

  const { config } = await loadProfileConfig(selection.workspaceRoot, selection.profile);
  const { target, source } = resolveTarget(config, flags.target, {
    allowUndeclared: options.allowUndeclaredTarget === true,
    ...env,
  });

  return {
    resolution: { ...selection, target, targetSource: source },
    config,
    target,
  };
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
  const declared = config.targets[target];
  if (!declared) throw undeclaredTarget(target, config);
  return openSecrets({ declared, config, root, target });
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
