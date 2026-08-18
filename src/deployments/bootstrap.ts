import { ConfigError, type Config, type DeployConfig, type TargetConfig } from '#profile';
import { VAULT_KEY_ENV, VAULT_KEY_REF } from '#secrets';
import { ok, print, style } from '#cli/output.ts';
import { isInteractive } from '#cli/prompt.ts';
import { ConfigDocument } from '#cli/config-edit.ts';
import { driverFor } from './drivers.ts';

/**
 * Getting a deployable target into the config, by asking rather than refusing.
 *
 * Split from `deploy.ts` because it is a different job: that file is the ordered
 * list of things that have to happen to roll a revision, and this is the one
 * question it has to settle before any of them — *where*. Keeping them together
 * put a config editor, a survey and a rollout in one file and pushed it past the
 * size budget `src/architecture.test.ts` holds.
 */

export interface TargetBootstrap {
  /** Override the declared `access` for this run. */
  readonly access?: string | undefined;
  readonly serviceAccount?: string | undefined;
  readonly profile?: string | undefined;
  /** Take what the config says without asking. Implied when nobody can answer. */
  readonly nonInteractive?: boolean | undefined;
}

/**
 * Whether this run asks its setup questions, or takes the stored answers.
 *
 * It asks every time, and that is the point: the values it collects are the ones
 * that decide where a revision lands, and a deploy where they are invisible
 * unless you open a YAML file is one you run without reading. Every prompt
 * defaults to what the config already says, so pressing return through the whole
 * survey changes nothing and re-generates nothing — the random project and
 * bucket names are stored values by then, not fresh draws.
 *
 * Two things stop it. A run with nobody at the keyboard has to use what is
 * stored or it dies at the first prompt, which would break every scripted
 * deploy; and `--non-interactive` says so explicitly, for a terminal that
 * happens to be attached to a job nobody is watching.
 *
 * Neither can rescue a target that is missing the answers. That still refuses,
 * at the prompt it could not ask.
 */
export function willSurvey(
  declared: TargetConfig | undefined,
  flags: TargetBootstrap,
  interactive: boolean,
): boolean {
  if (declared?.deploy === undefined) return true;
  return interactive && flags.nonInteractive !== true;
}

/**
 * The target this deploys, asked for whenever the config does not have it.
 *
 * Three cases, and the first used to be a refusal. A target that does not exist
 * at all was `Target "cloud" is not declared` plus a trip to the documentation
 * to hand-copy four adapter blocks — none of which has more than one workable
 * answer on a deployment, and one of which (`storage: filesystem`) *appears* to
 * work and silently discards everything on the next instance recycle. A command
 * that knows the right answer and refuses to write it is a command that has
 * chosen to be a worse copy of its own docs.
 *
 * Written back to the profile immediately rather than held for the run: the
 * answers are configuration, and configuration that lives only in a shell
 * history has to be retyped identically next time or it deploys somewhere else.
 */
export async function resolveTarget(input: {
  config: Config;
  profilePath: string;
  workspaceRoot: string;
  profile: string;
  target: string;
  flags: TargetBootstrap;
}): Promise<TargetConfig> {
  const { config, flags, target } = input;
  const declared = config.targets[target];
  const access = parseAccess(flags.access);

  const overrides = {
    ...(access ? { access } : {}),
    ...(flags.serviceAccount !== undefined ? { service_account: flags.serviceAccount } : {}),
  };

  // Nobody to ask, or told not to: the config is the answer, and flags override
  // for this run without editing anything.
  if (!willSurvey(declared, flags, isInteractive())) {
    return { ...declared!, deploy: { ...declared!.deploy!, ...overrides } };
  }

  // Only one platform exists, so asking which would be a question with one
  // answer. When a second lands, this is where it is asked.
  const driver = await driverFor('cloudrun');
  const surveyed = await driver.survey({
    current: { ...(declared?.deploy ?? {}), ...overrides },
    profile: input.profile,
    // A profile that authenticates remote clients itself wants the platform
    // door open; IAM in front of it admits only callers that can mint the
    // host's own identity token, which is none of them.
    gated: config.auth.authorization !== undefined,
    adapters: declared === undefined,
  });

  const document = await ConfigDocument.open(input.workspaceRoot, input.profile);

  if (declared) {
    document.setIn(['targets', target, 'deploy'], withoutUndefined(surveyed.target.deploy!));
  } else {
    document.setIn(['targets', target], deepWithoutUndefined(surveyed.target));
  }

  // `auth.authorization` is not part of the target and is written all the same:
  // the question that decides it is "will a remote client reach this", which
  // only a deploy is in a position to ask. See `SurveyResult`.
  if (surveyed.authorization) {
    document.setIn(['auth', 'authorization'], surveyed.authorization);
  }
  await document.save();

  print('');
  print(
    ok(
      declared
        ? `written to targets.${target}.deploy in ${input.profilePath}`
        : `written to targets.${target} in ${input.profilePath}`,
    ),
  );
  if (surveyed.authorization) {
    print(ok('written to auth.authorization — this endpoint will issue its own tokens'));
  }
  print(style.dim('  Edit it there, or re-run with --access to change who may reach it.'));

  return declared ? { ...declared, deploy: surveyed.target.deploy } : surveyed.target;
}

/**
 * The environment a revision reads out of its own credential store.
 *
 * Only the vault key, today. It is here rather than in the driver because
 * *whether* there is one is a property of the target's adapters, and which
 * platform mechanism mounts it is not.
 */
export function vaultEnv(declared: TargetConfig): Record<string, string> | undefined {
  const adapter = declared.vault?.adapter;
  if (adapter !== 'secret' && adapter !== 'blob') return undefined;
  return { [VAULT_KEY_ENV]: VAULT_KEY_REF };
}

export function parseAccess(value: string | undefined): DeployConfig['access'] | undefined {
  if (value === undefined) return undefined;
  if (value !== 'iam' && value !== 'public') {
    throw new ConfigError(`--access must be "iam" or "public", not "${value}"`);
  }
  return value;
}

/** `setIn` writes an explicit null for an undefined value, which then fails validation. */
function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** The same, for a whole target — every block inside it is an object too. */
export function deepWithoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key,
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? deepWithoutUndefined(entry as object)
          : entry,
      ]),
  ) as Partial<T>;
}
