import { existsSync } from 'node:fs';
import { isRemoteWorkspace, readWorkspaceFile, workspaceFiles } from './files.ts';
import { parseConfig, type LoadedConfig } from './load.ts';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './load.ts';
import {
  SUPPORTED_CONTRACT,
  connectionsFileSchema,
  workspaceSchema,
  type Config,
  type ConnectionsFile,
  type WorkspaceConfig,
} from './schema.ts';
import { assertConnectionsUnique, assertNoRenamedProviders } from './connections.ts';
import { findSecrets, formatSecretFindings } from './secret-detection.ts';

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
 * **A command says which profile it means, or it does not run** (ADR-037).
 * `--profile` is the only thing that selects one. `LANES_LINK_PROFILE` and
 * `default_profile` are parsed and ignored.
 *
 * The argument this replaces was that persisted selection is how operators act
 * on the wrong thing, and that a *visible* fallback — an exported variable, a
 * key in a file the operator reads, and a line printed before every command —
 * was therefore safe. The first half stands and is why this rule exists at all.
 * What did not survive is the conclusion: the printed line is a dim grey one,
 * and a fallback made an ignored flag survivable, so `profile add --target
 * cloud` dropping its flag surfaced on the *next* command, from a different
 * source, detached from its cause. A resolver with nothing to fall back to
 * cannot do that.
 *
 * The workspace root is deliberately not part of this and keeps its chain —
 * `LANES_LINK_HOME`, then an ancestor holding `lanes-link.yaml`, then
 * `~/.lanes-link`. Getting it wrong yields "no profiles here" rather than an
 * action against the wrong account, it is the only channel a container has for
 * its bucket (ADR-023), and the ancestor walk is what makes a per-repository
 * workspace work at all.
 */

export const WORKSPACE_FILE = 'lanes-link.yaml';

/** A profile, found. Everything a command needs before it has read the config. */
export interface ProfileSelection {
  readonly workspaceRoot: string;
  readonly profile: string;
  readonly profilePath: string;
}

/**
 * A profile and the target whose stores a command will open.
 *
 * There is no `profileSource`/`targetSource` any more, and nothing should
 * reintroduce them: with one way to select each, a source field has one
 * inhabitant, and `announce` would print `(flag)` twice on every line of every
 * command forever. `target.ts` already makes that argument about a line printed
 * unconditionally — it stops being read.
 */
export interface Resolution extends ProfileSelection {
  readonly target: string;
}

export interface ResolveOptions {
  readonly profileFlag?: string | undefined;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /**
   * The workspace to look in, when the caller has already resolved a target.
   *
   * A profile lives in exactly one target's workspace (ADR-052), so a command
   * naming a target has to follow it before it can say whether the profile
   * exists — the answer for `cloud` lives in a bucket and is nowhere on this
   * disk. Absent means the local root, which is what the commands taking no
   * target want.
   */
  readonly root?: string;
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

/** `connections.yaml` sits beside `lanes-link.yaml`, at the workspace root. */
export const CONNECTIONS_FILE = 'connections.yaml';

/**
 * Every account authorised in this workspace (ADR-057).
 *
 * Absent is not an error. A workspace that has never connected anything has no
 * file, and returning an empty set rather than throwing is what lets `profile
 * add`, `status` and `doctor` answer on a fresh install — the same reasoning
 * `readWorkspace` uses for returning null.
 *
 * Read through the workspace store rather than the filesystem, so a deployed
 * revision whose root is a bucket URL loads it (ADR-049). That was the exact
 * bug manifests hit: a filesystem read against a `gs://` root silently found
 * nothing and every custom provider vanished.
 */
export async function readConnections(workspaceRoot: string): Promise<ConnectionsFile> {
  const path = join(workspaceRoot, CONNECTIONS_FILE);
  const text = await readWorkspaceFile(workspaceFiles(workspaceRoot), CONNECTIONS_FILE);
  if (text === null) return { contract: SUPPORTED_CONTRACT, connections: [], oauth_apps: {} };

  const raw = parseYaml(text);

  const secrets = findSecrets(raw);
  if (secrets.length > 0) {
    throw new ConfigError(
      `${path}: ${formatSecretFindings(secrets)}`,
      secrets.map((finding) => finding.path),
    );
  }

  const parsed = connectionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `${path}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }

  assertConnectionsUnique(parsed.data.connections);
  assertNoRenamedProviders(
    parsed.data.connections,
    'lanes link doctor --fix --profile <name> --workspace <name>',
  );
  return parsed.data;
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
 * Find the profile a command names, or refuse saying what there is.
 *
 * `--profile` and nothing else. The refusal lists the workspace's profiles,
 * because "which one" is the question it is asking, and it names
 * `LANES_LINK_PROFILE` when that is set — the shell still configured for the old
 * world is the single most confusing state to be in during the change, and it
 * is self-limiting: the line disappears the moment the variable does.
 */
export async function resolveSelection(options: ResolveOptions = {}): Promise<ProfileSelection> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const workspaceRoot = options.root ?? resolveWorkspaceRoot(options);
  const profile = options.profileFlag;

  if (!profile) throw noProfileNamed(workspaceRoot, await listProfiles(workspaceRoot), env);

  const path = profilePath(workspaceRoot, profile);
  if (!(await workspaceFiles(workspaceRoot).has(`profiles/${profile}.yaml`))) {
    const available = await listProfiles(workspaceRoot);
    throw new ConfigError(
      `Profile "${profile}" does not exist (looked for ${path}).\n` +
        (available.length > 0 ? `Available: ${available.join(', ')}` : 'No profiles exist yet.'),
    );
  }

  return { workspaceRoot, profile, profilePath: path };
}

/** The refusal for a command that named no profile. Exported so it can be tested. */
export function noProfileNamed(
  workspaceRoot: string,
  available: readonly string[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ConfigError {
  if (available.length === 0) {
    return new ConfigError(
      `--profile is required, and ${workspaceRoot} holds no profiles yet.\n` +
        '  Create one with: lanes link profile add <name> --workspace local',
    );
  }

  const stale = env['LANES_LINK_PROFILE'];

  return new ConfigError(
    '--profile is required. Every command names the profile it acts on, and\n' +
      'nothing else selects one.\n\n' +
      `  Profiles in ${workspaceRoot}\n` +
      available.map((name) => `    ${name}`).join('\n') +
      `\n\n  e.g. lanes link status --profile ${available[0]} --workspace <name>` +
      (stale
        ? `\n\n  LANES_LINK_PROFILE=${stale} is set in this shell and is no longer read.\n` +
          '  Unset it, or pass --profile.'
        : ''),
  );
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
 * One profile, loaded, for the commands whose subject is the whole workspace.
 *
 * `profilePath` rather than a bare name because a caller reporting on several
 * profiles at once has nowhere to recompute it from without knowing whether the
 * root is a bucket.
 */
export interface LoadedProfile {
  readonly profile: string;
  readonly profilePath: string;
  readonly config: Config;
}

/**
 * Every profile in the workspace, and the ones that would not open.
 *
 * **Skipping rather than failing** is the same rule `openReconciled` follows for
 * a deployed endpoint: a workspace holding one broken profile still has a true
 * answer to give about the others, and a listing that dies on the first bad file
 * is one that stops working exactly when it is needed. What it must not do is
 * skip *silently* — `unreadable` is the half a caller has to print, and the
 * reason it carries the message rather than the error is that a caller rendering
 * a table has no use for a stack.
 */
export interface WorkspaceProfiles {
  readonly workspaceRoot: string;
  readonly loaded: readonly LoadedProfile[];
  readonly unreadable: readonly { readonly profile: string; readonly reason: string }[];
}

export async function loadWorkspaceProfiles(workspaceRoot: string): Promise<WorkspaceProfiles> {
  const loaded: LoadedProfile[] = [];
  const unreadable: { profile: string; reason: string }[] = [];

  for (const profile of await listProfiles(workspaceRoot)) {
    try {
      const { config } = await loadProfileConfig(workspaceRoot, profile);
      loaded.push({ profile, profilePath: profilePath(workspaceRoot, profile), config });
    } catch (error) {
      // First line only: a `ConfigError` from the loader carries every schema
      // issue on its own line, and a row in a table has room for none of them.
      const message = error instanceof Error ? error.message : String(error);
      unreadable.push({ profile, reason: message.split('\n')[0] ?? 'could not be read' });
    }
  }

  return { workspaceRoot, loaded, unreadable };
}
