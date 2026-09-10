import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readEndpointRecord } from '#profile';
import {
  defaultWorkspaceRoot,
  isDevInstall,
  legacyWorkspaceRoot,
  type HomeOptions,
} from '#home';

/**
 * Moving the workspace out of `~/.lanes-link` and into `~/.lanes/link`.
 *
 * Not a contract migration, and it cannot be one. Every migration in
 * `workspace-migrate.ts` rewrites files *inside* a workspace whose root is
 * already known, and stamps a number in a file to record that it finished. This
 * one moves the root itself, before anything has been read, and its record that
 * it finished is that the old directory is not there any more.
 *
 * It runs from `update` and from `doctor --fix`, and from nowhere else. The
 * alternative — the first command to notice the old root moves it — was
 * rejected for a reason worth writing down: this relocates the directory
 * holding somebody's credentials, their audit log and every profile they have,
 * and a `status` that quietly did that is one they cannot audit afterwards.
 * `resolveWorkspaceRoot` keeps resolving the old root in the meantime, so
 * nothing is lost by waiting and nobody is stranded by not upgrading.
 *
 * ## What it refuses, and why each one is a refusal rather than a warning
 *
 * All four are checked before the first byte moves — `migrateWorkspace`'s rule,
 * for the same reason: a refusal has to leave the workspace exactly as it was,
 * and the thing being moved is the only remaining description of where
 * somebody's accounts live.
 *
 *  - **A checkout.** Dev mode resolves to `~/.lanes-dev/link`, so applying this
 *    from one would move the operator's real workspace into a scratch home. The
 *    exact accident `#home` exists to prevent, arrived at from the other side.
 *  - **`LANES_LINK_HOME` is set.** An explicit root is a decision, and in a
 *    container it is a bucket. Neither is ours to relocate.
 *  - **Both roots exist.** Two workspaces is not a state this can resolve:
 *    merging them is not reversible and picking one silently discards the
 *    other's profiles. It reports both and stops.
 *  - **An endpoint is running.** `readEndpointRecord` already rejects a record
 *    whose pid is gone, so a live one means a `start` is holding the old path.
 *    Moving out from under it strands `endpoint.json` at a directory that no
 *    longer exists and leaves a process serving from one nobody can find —
 *    which presents as an endpoint that answers but cannot be reloaded.
 *  - **A target declares an absolute path inside the old root.** This is the
 *    one that would have been silent. `credentials.path`, `storage.path` and
 *    `vault.path` are optional, and `workspacePath` honours an absolute one
 *    verbatim — so a relative path (the default) travels with the directory
 *    while an absolute one goes on naming a location this migration just
 *    emptied. For `credentials.path` that is the encrypted credential store.
 */

/**
 * The one thing this takes from its caller rather than from the filesystem.
 *
 * `rename` succeeds on any machine where `$HOME` is one volume, which is nearly
 * all of them — so the copy fallback below, which is the half that handles
 * somebody's credentials in two steps instead of one, is unreachable from a
 * test without a second filesystem to mount. Injected on the same grounds
 * `PairDeps` injects `which` and `run`: the alternative is that the riskiest
 * code here is the only code with no test.
 */
export interface HomeMigrationDeps {
  readonly rename?: (from: string, to: string) => Promise<void>;
}

/** What the migration did, or would do. */
export interface HomeMigration {
  readonly from: string;
  readonly to: string;
  /** What happened, or would — spelled for display. */
  readonly changes: readonly string[];
  /** What stopped it, each a whole sentence naming the way out. */
  readonly blocked: readonly string[];
  /** Nothing to do: no legacy root, or this is not a machine that should move one. */
  readonly alreadyCurrent: boolean;
}

/**
 * Whether a resolved root is the one this migration moves.
 *
 * A string compare, so the commands that only *mention* the migration pay
 * nothing for it. `announce` calls this on every command.
 */
export function onLegacyRoot(root: string, options: HomeOptions = {}): boolean {
  return root === legacyWorkspaceRoot(options);
}

/** The line every other command prints, so nobody has to discover this by reading a changelog. */
export function legacyRootNotice(): string {
  return 'this workspace is at the old ~/.lanes-link — move it with: lanes link update';
}

/**
 * Run it and say what happened, for the two commands that may.
 *
 * Narrated rather than silent, on the same grounds `migrateLocal` states: this
 * relocates every byte somebody's workspace holds, and a command that does that
 * without a word is one they cannot audit afterwards. Routed through `say` so
 * `--json` can send it to stderr, where a line of prose does not corrupt the
 * document on stdout.
 *
 * **It never throws.** `update`'s job is to install a version and `doctor`'s is
 * to report; neither should fail because a directory would not move. What a
 * failure costs is one release cycle of staying where it is, since
 * `resolveWorkspaceRoot` still finds the old root — so the honest response is a
 * sentence, and the caller decides whether that is worth an exit code.
 */
export async function reportWorkspaceHomeMove(
  say: (line: string) => void,
  options: HomeOptions & { readonly apply: boolean; readonly deps?: HomeMigrationDeps },
): Promise<HomeMigration> {
  let migration: HomeMigration;

  try {
    migration = await migrateWorkspaceHome(options);
  } catch (error) {
    const from = legacyWorkspaceRoot(options);
    const reason = error instanceof Error ? error.message : String(error);
    say(`could not move ${from}: ${reason}`);
    return { from, to: defaultWorkspaceRoot(options), changes: [], blocked: [reason], alreadyCurrent: false };
  }

  if (migration.alreadyCurrent) return migration;

  for (const line of migration.blocked) say(`this workspace has not been moved: ${line}`);
  for (const line of migration.changes) {
    say(options.apply ? line : `${line} — run with --fix to do it`);
  }

  return migration;
}

export async function migrateWorkspaceHome(
  options: HomeOptions & { readonly apply: boolean; readonly deps?: HomeMigrationDeps },
): Promise<HomeMigration> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const from = legacyWorkspaceRoot(options);
  const to = defaultWorkspaceRoot(options);
  const nothing = { from, to, changes: [], blocked: [], alreadyCurrent: true } as const;

  // Ordered cheapest first, and the three that mean "not this machine's job"
  // report `alreadyCurrent` rather than `blocked`: a checkout running `update`
  // has not failed at anything, and printing a refusal at it every time would
  // train the reader to skip the ones that matter.
  if (env['LANES_LINK_HOME']) return nothing;
  if (isDevInstall(options)) return nothing;
  if (!existsSync(from)) return nothing;

  const blocked: string[] = [];

  // Both present has two readings, and they want opposite things. It is either
  // two real workspaces — which this must not touch — or the copy path below
  // having been interrupted between writing the new one and deleting the old,
  // which a rerun is supposed to finish rather than refuse. The evidence that
  // separates them is whether the new root already holds everything the old one
  // does; if it does, there is nothing here to merge and this is the delete
  // that did not happen.
  if (existsSync(to)) {
    if (await holdsEverything(from, to)) {
      const changes = [`${from} was already copied to ${to} — removing what is left`];
      if (options.apply) await rm(from, { recursive: true, force: true });
      return { from, to, changes, blocked, alreadyCurrent: false };
    }

    blocked.push(
      `${to} already exists and holds something different, so there are two workspaces\n` +
        '  and only one can have that name. Merging them is not something this can undo,\n' +
        `  so it has not been attempted. Look at both, then move or delete ${from} yourself.`,
    );
  }

  const running = await readEndpointRecord(from);
  if (running !== null) {
    blocked.push(
      `an endpoint is serving ${from} (pid ${running.pid}, ${running.url}).\n` +
        '  Moving the workspace while it is open would leave it serving a directory that\n' +
        '  no longer exists. Stop it, run this again, and start it back up.',
    );
  }

  for (const stranded of await absolutePathsWithin(from)) {
    blocked.push(
      `${stranded} is an absolute path inside ${from}, so it would not travel with the\n` +
        '  workspace — it would go on naming a directory this migration had emptied.\n' +
        '  Make it relative to the workspace root, or point it somewhere else, then run this again.',
    );
  }

  if (blocked.length > 0) return { from, to, changes: [], blocked, alreadyCurrent: false };

  const changes = [`workspace ${from} → ${to}`];
  if (!options.apply) return { from, to, changes, blocked, alreadyCurrent: false };

  // `0700` on anything this creates. `~/.lanes` may already exist — the desktop
  // app owns it too — in which case `recursive` leaves its mode alone, which is
  // right: it is not ours to tighten or loosen. What must not happen is this
  // command creating it at the default umask, because what goes inside is
  // `credentials.enc` and its key.
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await move(from, to, options.deps?.rename ?? rename);

  return { from, to, changes, blocked, alreadyCurrent: false };
}

/**
 * `rename` where it works, a verified copy where it does not.
 *
 * `rename` is the whole migration in one syscall when both paths are on one
 * filesystem, which under `$HOME` they almost always are: atomic, no window
 * where a reader sees half a workspace, and nothing left behind to delete.
 *
 * `EXDEV` is the case that is not — a home directory on a different volume from
 * `~/.lanes-link`, which happens on machines where one of them is a mount. Then
 * it is copy, read back, delete, in that order, because that is the order that
 * survives being interrupted: a crash after the copy leaves both and the rerun
 * finishes, where a crash after a delete leaves neither.
 *
 * Not a key-by-key drain through `workspaceFiles()`, which is the other obvious
 * way to move a workspace and is wrong here twice over: the filesystem blob
 * store's `list` skips the `.meta` and `.tmp` sidecars, so content types would
 * be silently dropped, and its `delete` prunes empty parents but never the root
 * — so the directory this is supposed to remove would still be sitting there.
 */
async function move(
  from: string,
  to: string,
  attemptRename: (from: string, to: string) => Promise<void>,
): Promise<void> {
  try {
    await attemptRename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }

  // `cp` carries the mode of every file and every nested directory, but not of
  // the destination root — that one arrives at the default umask, measured at
  // 0755. Left alone it would publish a directory listing of somebody's
  // profiles, so it is set from the source rather than to a constant: whatever
  // the old root was is what the new one should be.
  const mode = (await stat(from)).mode & 0o777;
  await cp(from, to, { recursive: true, preserveTimestamps: true });
  await chmod(to, mode);

  if (!(await holdsEverything(from, to))) {
    throw new Error(
      `${to} does not hold everything in ${from}, so the copy did not finish. Nothing has ` +
        `been deleted and ${from} is still intact — run this again.`,
    );
  }

  await rm(from, { recursive: true, force: true });
}

/**
 * Whether every file under `from` is present under `to`, at the same size.
 *
 * The read-back half of the rule this repository's migrations all follow —
 * nothing is deleted until what replaced it has been read back. Not a checksum,
 * and it does not need to be: what it defends against is a copy that stopped
 * partway, which is otherwise a failure discovered by the delete.
 *
 * A superset is a pass. The new root may legitimately hold more — a `.tmp` from
 * a write that was in flight, or the sidecars `cp` carried over — and requiring
 * the two listings to be equal would fail a copy that had in fact worked.
 */
async function holdsEverything(from: string, to: string): Promise<boolean> {
  const before = await inventory(from);
  const after = await inventory(to);

  return [...before].every(([key, size]) => after.get(key) === size);
}

/** Every file under a root, keyed by its path relative to it, valued by size. */
async function inventory(root: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.set(relative(root, full), (await stat(full)).size);
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Every `path:` in this workspace's YAML that points inside it absolutely.
 *
 * Every `.yaml` under the root rather than only the registry, because the
 * question is "does anything name this directory in a way that will not move",
 * and answering it from the schema would mean knowing which schema — a
 * workspace still at contract 2 has its targets somewhere else entirely. A deep
 * walk over the parsed document cannot be wrong about the shape because it does
 * not assume one.
 */
async function absolutePathsWithin(root: string): Promise<string[]> {
  const inside = `${root}${sep}`;
  const stranded: string[] = [];

  const scan = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${where}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;

    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
      const at = where === '' ? key : `${where}.${key}`;
      if (key === 'path' && typeof held === 'string' && isAbsolute(held) && held.startsWith(inside)) {
        stranded.push(`${at}: ${held}`);
      } else {
        scan(held, at);
      }
    }
  };

  for (const file of await yamlFiles(root)) {
    let parsed: unknown;
    try {
      parsed = parseYaml(await readFile(file, 'utf8'));
    } catch {
      // A file that will not parse is not this function's problem to report.
      // `doctor` gives it a better sentence than "blocks the migration" would,
      // and a workspace is not made unmovable by one unreadable file.
      continue;
    }
    scan(parsed, relative(root, file));
  }

  return stranded;
}

/** The registry and every profile declaration, wherever this workspace's contract put them. */
async function yamlFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      // `.d` and `.kv` directories hold a provider's own bytes and a store's
      // keys. Neither declares a path, both can be large, and `skills.d` in
      // particular is somebody's prose.
      if (entry.isDirectory()) {
        if (!entry.name.includes('.')) await walk(full);
      } else if (entry.name.endsWith('.yaml')) {
        found.push(full);
      }
    }
  };

  await walk(root);
  return found;
}
