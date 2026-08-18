import { existsSync } from 'node:fs';
import { isRemoteWorkspace, readWorkspaceFile, workspaceFiles } from './files.ts';
import { parseConfig, type LoadedConfig } from './load.ts';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './load.ts';
import { workspaceSchema, type Config, type WorkspaceConfig } from './schema.ts';

/**
 * Workspace and profile resolution.
 *
 * A workspace is a directory holding one or more profiles:
 *
 *   lanes-link.yaml      workspace settings: contract, default_profile
 *   profiles/
 *     personal.yaml
 *     work.yaml
 *   data/               local state per profile, gitignored
 *
 * There is deliberately no sticky `lanes link use` that persists a current selection.
 * Persisted context state is the standard way operators run destructive
 * commands against the wrong target; `export LANES_LINK_PROFILE=work` gives the
 * same convenience while staying visible in the shell.
 */

export const WORKSPACE_FILE = 'lanes-link.yaml';

export interface Resolution {
  readonly workspaceRoot: string;
  readonly profile: string;
  readonly profilePath: string;
  readonly target: string;
  /** Where the value came from, so every command can print how it got here. */
  readonly profileSource: 'flag' | 'environment' | 'workspace-default';
  /**
   * `deployable` is `deploy` choosing the only target it could have meant.
   *
   * It is its own source rather than reusing `config-default` because it is a
   * different claim: the config default is what *commands* run against, and for
   * every other command that is the local target. Printing "config-default"
   * beside a target the config does not default to would be a lie on the one
   * line that exists to say how the command got here.
   */
  readonly targetSource: 'flag' | 'config-default' | 'deployable';
}

export interface ResolveOptions {
  readonly profileFlag?: string | undefined;
  readonly targetFlag?: string | undefined;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

/**
 * `LANES_LINK_HOME`, else the nearest ancestor containing `lanes-link.yaml`,
 * else `~/.lanes-link`.
 */
export function resolveWorkspaceRoot(options: ResolveOptions = {}): string {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const explicit = env['LANES_LINK_HOME'];
  // A bucket URL is already absolute; `resolve` would turn `gs://b/p` into a
  // path under the current directory and the failure would arrive much later,
  // as a missing file rather than as a mangled root.
  if (explicit) return isRemoteWorkspace(explicit) ? explicit.replace(/\/$/, '') : resolve(explicit);

  let directory = resolve(options.cwd ?? process.cwd());
  for (;;) {
    // `existsSync`, not `Bun.file(path).size`: a missing file reports size 0,
    // so a `>= 0` check would call every candidate a workspace and stop at the
    // first directory it looked at.
    if (existsSync(join(directory, WORKSPACE_FILE))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return join(homedir(), '.lanes-link');
}

/**
 * Where Lanes Link itself is installed — the directory holding `package.json`,
 * and with it `skills/` and `docs/`.
 *
 * Not the workspace: this is the code, not the operator's data. Found by
 * walking up rather than by counting `..` segments, because the count is a
 * function of where the calling file sits and a file that moves one level takes
 * a silently wrong path with it. Both callers had already been through that
 * once.
 */
export function installRoot(from: string): string {
  let directory = resolve(from);
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`No package.json in any directory above ${from}`);
    }
    directory = parent;
  }
}

/**
 * Where a profile's config lives, for display and for filesystem callers.
 *
 * `join` would collapse the `//` in a bucket URL, so a remote root composes by
 * hand. Loading goes through `loadProfileConfig` rather than this — what a
 * command prints and what it reads stopped being the same string when the
 * workspace stopped being a directory.
 */
export function profilePath(workspaceRoot: string, profile: string): string {
  const key = `profiles/${profile}.yaml`;
  return isRemoteWorkspace(workspaceRoot) ? `${workspaceRoot}/${key}` : join(workspaceRoot, key);
}

/** A profile's config, however this workspace is stored. */
export async function loadProfileConfig(
  workspaceRoot: string,
  profile: string,
): Promise<LoadedConfig> {
  const key = `profiles/${profile}.yaml`;
  const text = await readWorkspaceFile(workspaceFiles(workspaceRoot), key);
  const shown = profilePath(workspaceRoot, profile);

  if (text === null) throw new ConfigError(`${shown}: no such config file`);
  return parseConfig(text, shown);
}

export async function readWorkspace(workspaceRoot: string): Promise<WorkspaceConfig | null> {
  const path = join(workspaceRoot, WORKSPACE_FILE);
  const text = await readWorkspaceFile(workspaceFiles(workspaceRoot), WORKSPACE_FILE);
  if (text === null) return null;

  const parsed = workspaceSchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    throw new ConfigError(
      `${path}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return parsed.data;
}

export async function listProfiles(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await workspaceFiles(workspaceRoot).list('profiles/');
    return entries
      .map((entry) => entry.key.slice('profiles/'.length))
      .filter((name) => name.endsWith('.yaml') && !name.endsWith('.example.yaml'))
      // Direct children only: a nested directory under `profiles/` is not a
      // profile, and a bucket listing is flat so it would otherwise look like one.
      .filter((name) => !name.includes('/'))
      .map((name) => name.slice(0, -'.yaml'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve which profile and target a command acts on.
 *
 * Order: `--profile`, then `LANES_LINK_PROFILE`, then the workspace's
 * `default_profile`, then an error that lists what is available — never a
 * silent pick, because the wrong guess here operates on the wrong accounts.
 */
export async function resolveSelection(options: ResolveOptions = {}): Promise<Resolution> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const workspaceRoot = resolveWorkspaceRoot(options);

  let profile: string | undefined;
  let profileSource: Resolution['profileSource'] = 'workspace-default';

  if (options.profileFlag) {
    profile = options.profileFlag;
    profileSource = 'flag';
  } else if (env['LANES_LINK_PROFILE']) {
    profile = env['LANES_LINK_PROFILE'];
    profileSource = 'environment';
  } else {
    profile = (await readWorkspace(workspaceRoot))?.default_profile;
    profileSource = 'workspace-default';
  }

  if (!profile) {
    const available = await listProfiles(workspaceRoot);
    throw new ConfigError(
      `No profile selected in workspace ${workspaceRoot}.\n` +
        (available.length > 0
          ? `Available: ${available.join(', ')}\n` +
            `Pass --profile <name>, set LANES_LINK_PROFILE, or set default_profile in ${WORKSPACE_FILE}.`
          : `No profiles exist yet. Create one with: lanes link profile add <name> --default`),
    );
  }

  const path = profilePath(workspaceRoot, profile);
  if (!(await workspaceFiles(workspaceRoot).has(`profiles/${profile}.yaml`))) {
    const available = await listProfiles(workspaceRoot);
    throw new ConfigError(
      `Profile "${profile}" does not exist (looked for ${path}).\n` +
        (available.length > 0 ? `Available: ${available.join(', ')}` : 'No profiles exist yet.'),
    );
  }

  return {
    workspaceRoot,
    profile,
    profilePath: path,
    target: options.targetFlag ?? '',
    profileSource,
    targetSource: options.targetFlag ? 'flag' : 'config-default',
  };
}

/**
 * Fill in the target once the profile's config has been loaded.
 *
 * `allowUndeclared` is for the one command whose job is to create the target it
 * was given — `deploy`, on a first run. Every other command naming a target that
 * does not exist has made a typo, and the list of what does exist is the useful
 * answer; refusing there is what stops `--target clod` opening the default one.
 */
export function resolveTarget(
  config: Config,
  targetFlag?: string,
  options: { allowUndeclared?: boolean } = {},
): { target: string; source: 'flag' | 'config-default' } {
  const target = targetFlag ?? config.instance.default_target;
  if (options.allowUndeclared !== true && !(target in config.targets)) {
    throw new ConfigError(
      `Target "${target}" is not declared in this profile (have: ${Object.keys(config.targets).join(', ') || 'none'})`,
    );
  }
  return { target, source: targetFlag ? 'flag' : 'config-default' };
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

/**
 * Resolve a target-relative path against the workspace root.
 *
 * Only meaningful for the adapters that take a filesystem path — `file`
 * credentials, the `filesystem` blob store. A workspace in a bucket selects
 * none of those, so reaching here with a remote root means a target declared a
 * local adapter against a remote workspace, and saying so beats handing a
 * `gs://…/data/x` string to `Bun.file`.
 */
export function workspacePath(workspaceRoot: string, path: string): string {
  if (isRemoteWorkspace(workspaceRoot)) {
    throw new ConfigError(
      `This target wants a filesystem path ("${path}"), but the workspace is ${workspaceRoot}. ` +
        'A workspace in a bucket can only use adapters that address it as one: ' +
        'credentials `gcp-secret-manager`, storage `gcs` or `s3`, vault `secret` or `blob`.',
    );
  }
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

/**
 * The line every command prints before acting, read-only commands included.
 *
 * This is the primary guard against operating on the wrong instance, and it
 * costs one line.
 */
export function describeSelection(resolution: Resolution): string {
  return `profile: ${resolution.profile} (${resolution.profileSource})   target: ${resolution.target} (${resolution.targetSource})`;
}
