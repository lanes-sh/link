import { ConfigError } from './load.ts';
import type { Config } from './schema.ts';

/**
 * Which target a command acts on.
 *
 * A target names an adapter set — where credentials are kept and where bytes
 * go — and choosing one is a different subject from finding the workspace and
 * the profile, which is why it is a different file.
 *
 * **`--target`, or the command does not run** (ADR-037). There is no fallback:
 * not `LANES_LINK_TARGET`, not `instance.default_target`. Both are still
 * parsed, so no existing config file has to change, and neither is read.
 *
 * The chain this replaces resolved `--target`, then the variable, then the key,
 * and printed which of the three it landed on. What that bought was one flag
 * saved per command. What it cost was that an *ignored* flag still produced a
 * working command — `profile add --target cloud` dropped the flag on the floor
 * and the next command carried on from a different source, so the mistake
 * surfaced one command later with nothing connecting it to its cause. A
 * resolver with nowhere to fall back to cannot fail that way.
 */

/**
 * The target this command named, checked against what the profile declares.
 *
 * `allowUndeclared` is for the one command whose job is to create the target it
 * was given — `deploy`, on a first run. Every other command naming a target that
 * does not exist has made a typo, and the list of what does exist is the useful
 * answer.
 */
export function requireTarget(
  config: Config,
  targetFlag: string | undefined,
  options: { allowUndeclared?: boolean; profile?: string } = {},
): string {
  if (!targetFlag) throw noTargetNamed(config, options.profile);

  if (options.allowUndeclared !== true && !(targetFlag in config.targets)) {
    throw undeclaredTarget(targetFlag, config, options.profile);
  }

  return targetFlag;
}

/**
 * The refusal for a command that named no target.
 *
 * It lists the targets with their adapters, because "which one" is the question
 * being asked and the adapter set is what distinguishes them. It also reports
 * the two things that used to answer this and no longer do — an exported
 * variable and the key still sitting in the file — since an operator looking at
 * either has every reason to believe it is still working.
 */
export function noTargetNamed(
  config: Config,
  profile?: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ConfigError {
  const names = Object.keys(config.targets);
  const whose = profile ? ` by profile "${profile}"` : '';

  const rows = names
    .map((name) => {
      const declared = config.targets[name]!;
      const deployed = declared.deploy ? '  deployed' : '';
      return `    ${name}    ${declared.credentials.adapter}  ${declared.storage.adapter}${deployed}`;
    })
    .join('\n');

  const stale = env[LEGACY_TARGET_ENV];
  const inert = config.instance.default_target;

  return new ConfigError(
    '--target is required. This command opens a target\'s stores, and nothing\n' +
      'else selects one.\n\n' +
      `  Targets declared${whose}\n${rows}\n` +
      `\n  e.g. lanes link status --profile ${profile ?? '<name>'} --target ${names[0] ?? '<target>'}` +
      (stale
        ? `\n\n  ${LEGACY_TARGET_ENV}=${stale} is set in this shell and is no longer read.\n` +
          '  Unset it, or pass --target.'
        : '') +
      (inert
        ? `\n\n  instance.default_target: ${inert} is still in this profile. It is no longer\n` +
          '  read either, and is safe to delete.'
        : ''),
  );
}

/**
 * The variable that used to name a target, kept only to say it is ignored.
 *
 * Not read by anything that resolves. It exists so a refusal can name the thing
 * an operator is looking at and reasonably believes is still working — which is
 * the whole difference between "this stopped working" and "this stopped working
 * and here is why".
 */
export const LEGACY_TARGET_ENV = 'LANES_LINK_TARGET';

/**
 * The refusal for a target that is not in the file, in one spelling.
 *
 * It was two — here and in the CLI's `openSecretStoreFor` — which is one more
 * than a sentence naming the available targets survives: the copies drift the
 * moment either learns something the other does not.
 */
export function undeclaredTarget(target: string, config: Config, profile?: string): ConfigError {
  const have = Object.keys(config.targets).join(', ') || 'none';
  const whose = profile ? `profile "${profile}"` : 'this profile';

  return new ConfigError(`Target "${target}" is not declared by ${whose} (have: ${have})`);
}

/**
 * The refusal for a target-scoped command that named no target.
 *
 * The twin of `noTargetNamed`, for the commands whose subject is the target
 * rather than one profile's view of it (ADR-043). It lists the target names the
 * *workspace* declares and who declares each, because the question those
 * commands are asking is "which endpoint", and a target only one profile knows
 * about is the answer to a different question than one they all share.
 *
 * Naming the profiles is not decoration. A target declared by one profile and
 * not its sibling is precisely the state that reads as a deployment having
 * disappeared, and it is invisible from inside either profile alone.
 */
export function noTargetInWorkspace(
  declared: ReadonlyMap<string, readonly string[]>,
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ConfigError {
  if (declared.size === 0) {
    return new ConfigError(
      `--target is required, and no profile in ${workspaceRoot} declares one.\n` +
        '  Create a profile with: lanes link profile add <name> --target local',
    );
  }

  const total = new Set(
    [...declared.values()].flatMap((profiles) => profiles as readonly string[]),
  ).size;

  const rows = [...declared.entries()]
    .map(([name, profiles]) => {
      // "every profile" rather than the list once it is all of them: the list is
      // there to show a gap, and a complete one shows none.
      const whose = profiles.length === total ? 'every profile' : profiles.join(', ');
      return `    ${name}    ${whose}`;
    })
    .join('\n');

  const first = [...declared.keys()][0]!;
  const stale = env[LEGACY_TARGET_ENV];

  return new ConfigError(
    '--target is required. This command acts on a target, and every profile\n' +
      'that declares it.\n\n' +
      `  Targets in ${workspaceRoot}\n${rows}\n` +
      `\n  e.g. lanes link status --target ${first}` +
      (stale
        ? `\n\n  ${LEGACY_TARGET_ENV}=${stale} is set in this shell and is no longer read.\n` +
          '  Unset it, or pass --target.'
        : ''),
  );
}
