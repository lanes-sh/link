import { ConfigError } from './load.ts';
import { isPointer, type WorkspaceTarget } from './schema.ts';

/**
 * Which target a command acts on.
 *
 * A target names an adapter set — where credentials are kept and where bytes
 * go — and choosing one is a different subject from finding the workspace and
 * the profile, which is why it is a different file.
 *
 * **`--target`, or the command does not run** (ADR-037). There is no fallback:
 * not `LANES_LINK_TARGET`, not `instance.default_target`. The variable is still
 * named in a refusal so a shell configured for the old world can be told it is
 * ignored; the key went with contract 1.
 *
 * The chain this replaces resolved `--target`, then the variable, then the key,
 * and printed which of the three it landed on. What that bought was one flag
 * saved per command. What it cost was that an *ignored* flag still produced a
 * working command — `profile add --target cloud` dropped the flag on the floor
 * and the next command carried on from a different source, so the mistake
 * surfaced one command later with nothing connecting it to its cause. A
 * resolver with nowhere to fall back to cannot fail that way.
 *
 * **What changed under ADR-052** is where the list of targets comes from. It was
 * one profile's `targets:` block, which meant "is this target declared" had a
 * different answer per profile and a deployment could look vanished from inside
 * one of them. It is now the workspace registry — one list, before any profile
 * is read, which is what lets `--target` be chosen first.
 */

export type Registry = Record<string, WorkspaceTarget>;

/**
 * The target this command named, checked against the workspace registry.
 *
 * `allowUndeclared` is for the one command whose job is to create the target it
 * was given — `deploy`, on a first run. Every other command naming a target that
 * does not exist has made a typo, and the list of what does exist is the useful
 * answer.
 */
export function requireTarget(
  registry: Registry,
  targetFlag: string | undefined,
  options: { allowUndeclared?: boolean; root?: string } = {},
): string {
  if (!targetFlag) throw noTargetNamed(registry, options.root);

  if (options.allowUndeclared !== true && !(targetFlag in registry)) {
    throw notInRegistry(targetFlag, registry, options.root);
  }

  return targetFlag;
}

/**
 * The refusal for a command that named no target.
 *
 * It lists the targets and where each lives, because "which one" is the question
 * being asked and here-versus-elsewhere is what distinguishes them. It also
 * reports the variable that used to answer this and no longer does, since an
 * operator with it exported has every reason to believe it still works.
 *
 * One refusal rather than the two this replaced. `noTargetNamed` used to list
 * one profile's adapters and `noTargetInWorkspace` listed which profiles
 * declared each name — a distinction that existed only because a target was
 * declared per profile. There is one list now, so there is one sentence.
 */
export function noTargetNamed(
  registry: Registry,
  root?: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ConfigError {
  const names = Object.keys(registry).sort();
  const where = root ?? 'this workspace';

  if (names.length === 0) {
    return new ConfigError(
      `--target is required, and ${where} declares none.\n` +
        '  Create one with: lanes link profile add <name> --target local',
    );
  }

  const stale = env[LEGACY_TARGET_ENV];

  return new ConfigError(
    '--target is required. This command opens a target\'s stores, and nothing\n' +
      'else selects one.\n\n' +
      `  Targets in ${where}\n${rows(registry, names)}\n` +
      `\n  e.g. lanes link status --target ${names[0]}` +
      (stale
        ? `\n\n  ${LEGACY_TARGET_ENV}=${stale} is set in this shell and is no longer read.\n` +
          '  Unset it, or pass --target.'
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
 *
 * The deployed image still *sets* it, and that is not a contradiction: a
 * revision serves exactly one target and passes it to `serve` on the command
 * line. Nothing resolves from the variable on either side.
 */
export const LEGACY_TARGET_ENV = 'LANES_LINK_TARGET';

/** The refusal for a target that is not in the registry, in one spelling. */
export function notInRegistry(target: string, registry: Registry, root?: string): ConfigError {
  const names = Object.keys(registry).sort();
  const where = root ?? 'this workspace';

  if (names.length === 0) {
    return new ConfigError(`Target "${target}" is not declared, and ${where} declares none.`);
  }

  return new ConfigError(
    `Target "${target}" is not declared in ${where}.\n\n  Targets\n${rows(registry, names)}`,
  );
}

function rows(registry: Registry, names: readonly string[]): string {
  return names
    .map((name) => {
      const entry = registry[name]!;
      if (isPointer(entry)) return `    ${name}    ${entry.workspace}`;
      const adapters = [entry.credentials?.adapter, entry.storage?.adapter]
        .filter(Boolean)
        .join('  ');
      return `    ${name}    here  ${adapters}${entry.deploy ? '  deployable' : ''}`;
    })
    .join('\n');
}
