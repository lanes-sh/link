import { ConfigError } from './load.ts';
import type { Config } from './schema.ts';

/**
 * Which target a command acts on.
 *
 * A target names an adapter set — where credentials are kept and where bytes
 * go — and choosing one is a different subject from finding the workspace and
 * the profile, which is why it is a different file. `workspace.ts` reached the
 * size budget holding both, and the budget's job is to say which of the two
 * things a file is doing should leave.
 *
 * The order is `--target`, then `LANES_LINK_TARGET`, then
 * `instance.default_target`. `deploy` resolves it differently and deliberately;
 * see `resolveDeployTarget`.
 */

/** The variable that names a target for every command in a shell. */
export const TARGET_ENV = 'LANES_LINK_TARGET';

/**
 * The target somebody asked for, before the config gets a say.
 *
 * Split out because two callers need this precedence and must not disagree
 * about it: `resolveSelection` records a provisional answer for `announce`
 * before any config is loaded, and `resolveTarget` settles it afterwards. While
 * the flag was the only source, both could spell it `targetFlag ?? …` and stay
 * accidentally correct. With a second source, one of them learning about it and
 * the other not is a line reading `config-default` beside a target the
 * environment chose — which is the one line that exists to prevent exactly that.
 *
 * Returns no target rather than a default: what an unanswered question falls
 * back to is `instance.default_target`, and that is the config's to supply.
 */
export function askedTarget(
  targetFlag: string | undefined,
  env: Record<string, string | undefined>,
): { target: string | undefined; source: 'flag' | 'environment' | undefined } {
  if (targetFlag) return { target: targetFlag, source: 'flag' };

  const fromEnv = env[TARGET_ENV];
  if (fromEnv) return { target: fromEnv, source: 'environment' };

  return { target: undefined, source: undefined };
}

/**
 * The refusal for a target that is not in the file, in one spelling.
 *
 * It was two — here and in the CLI's `openSecretStoreFor` — which is one more
 * than a sentence naming the available targets survives: the copies drift the
 * moment either learns something the other does not. This one knows about
 * `LANES_LINK_TARGET`, and that is precisely the knowledge a copy would lack —
 * an exported typo otherwise fails every command in the shell with a message
 * that reads as a problem with the config file.
 */
export function undeclaredTarget(
  target: string,
  config: Config,
  source?: 'flag' | 'environment' | 'config-default',
): ConfigError {
  const have = Object.keys(config.targets).join(', ') || 'none';
  return new ConfigError(
    `Target "${target}" is not declared in this profile (have: ${have})` +
      (source === 'environment'
        ? `\n${TARGET_ENV}=${target} is set in this shell — unset it, or pass --target.`
        : ''),
  );
}

/**
 * Fill in the target once the profile's config has been loaded.
 *
 * Order: `--target`, then `LANES_LINK_TARGET`, then `instance.default_target`.
 * The middle one is the same bargain `LANES_LINK_PROFILE` already offers — a
 * shell's worth of commands without retyping a flag, somewhere `env` shows it.
 *
 * `allowUndeclared` is for the one command whose job is to create the target it
 * was given — `deploy`, on a first run. Every other command naming a target that
 * does not exist has made a typo, and the list of what does exist is the useful
 * answer; refusing there is what stops `--target clod` opening the default one.
 */
export function resolveTarget(
  config: Config,
  targetFlag?: string,
  options: {
    allowUndeclared?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): { target: string; source: 'flag' | 'environment' | 'config-default' } {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const asked = askedTarget(targetFlag, env);

  const target = asked.target ?? config.instance.default_target;
  const source = asked.source ?? 'config-default';

  if (options.allowUndeclared !== true && !(target in config.targets)) {
    throw undeclaredTarget(target, config, source);
  }
  return { target, source };
}

/**
 * The target a deploy means, when nobody said.
 *
 * `--target cloud` was required on every deploy, and the reason was an accident:
 * an absent flag falls back to `instance.default_target`, which is `local` —
 * a target that by definition is not deployed anywhere. So the one command whose
 * subject is never ambiguous was the one command that made you say it, and the
 * default it would otherwise have taken was not merely unhelpful but wrong.
 *
 * The rule is what someone would say out loud: deploy the target that has a
 * deployment. One is the answer; none means the first run, which conventionally
 * creates `cloud` and is what every example in the docs names; several is a
 * genuine question, and asking beats rolling a revision to whichever came first
 * in a YAML mapping.
 *
 * `--target` still wins, which is how you deploy the second one.
 *
 * **`LANES_LINK_TARGET` is deliberately not read here.** It is the same kind of
 * answer as `instance.default_target` — a shell-wide "where do my commands
 * run" — and the paragraph above is why that kind of answer is the wrong one
 * for this question. It is also the only place where being wrong creates cloud
 * resources rather than an error: `deploy` is the one caller that passes
 * `allowUndeclared`, so an exported typo would not be refused, it would be
 * surveyed, written into the profile, and rolled out as a new service. An
 * environment variable must not be able to name a Cloud Run service into
 * existence. Say `--target`; `deploy` is rare enough to afford it.
 */
export const CONVENTIONAL_DEPLOY_TARGET = 'cloud';

export function resolveDeployTarget(
  config: Config,
  targetFlag?: string,
): { target: string; source: 'flag' | 'deployable' } {
  if (targetFlag) return { target: targetFlag, source: 'flag' };

  // `deploy` alone: the legacy `cloudrun:` spelling is normalised into it by the
  // loader, so exactly one shape reaches here.
  const deployable = Object.entries(config.targets)
    .filter(([, declared]) => declared.deploy !== undefined)
    .map(([name]) => name);

  if (deployable.length > 1) {
    throw new ConfigError(
      `This profile declares ${deployable.length} deployable targets (${deployable.join(', ')}). ` +
        'Name the one you mean with --target.',
    );
  }

  return { target: deployable[0] ?? CONVENTIONAL_DEPLOY_TARGET, source: 'deployable' };
}
