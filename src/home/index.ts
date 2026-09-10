import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Where Lanes keeps things on this machine, in one place.
 *
 * `~/.lanes` is the Lanes home and it is older than this CLI: the desktop app
 * keeps `auth.json`, `settings.json`, `database.db` and `integrations.json`
 * there, and `#auth/lanes/session.ts` keeps the signed-in session beside them.
 * The workspace was the one thing that lived outside it, at `~/.lanes-link`,
 * for no reason anybody could state — so one product had two conventions and a
 * reader had two directories to know about. It is `~/.lanes/link` now.
 *
 * ## Why this is a component of its own
 *
 * Two callers need the same answer and neither may import the other. `#profile`
 * resolves the workspace root; `#auth` resolves the session path; and
 * `src/architecture.test.ts` gives `auth` only `secrets` and `stores`, which is
 * the right layering and not worth breaking for a path. Spelling the answer
 * twice is the failure `layout.ts` already records — "two spellings of one
 * filename is how a listing and a loader come to disagree about what exists" —
 * and it would be worse here, because the two would disagree about *which
 * machine directory holds the operator's credentials*.
 *
 * So it is a leaf: it imports nothing, and everything may import it.
 *
 * ## Dev mode
 *
 * A checkout gets `~/.lanes-dev` instead, and the whole home moves rather than
 * just the workspace — a `lanes auth login` run while testing a branch must not
 * sign the operator out of the install they actually use.
 *
 * This closes a hazard that used to be handled by remembering. Running the CLI
 * out of a worktree resolved to the operator's real `~/.lanes-link` — live
 * profiles, credentials, state, audit log — and `deploy` and `sync targets`
 * both *write* there. The remedy was an exported `LANES_LINK_HOME`, which works
 * exactly as often as it is remembered. Now the safe answer is the default, and
 * reaching the real workspace from a checkout is what you have to say out loud.
 */

/** The Lanes home directory name, under `$HOME`. */
export const LANES_DIR = '.lanes';

/** The same, for a CLI running out of a checkout. */
export const LANES_DEV_DIR = '.lanes-dev';

/**
 * What the workspace root was called through 0.13.
 *
 * Recognised, never written — the rule `LEGACY_WORKSPACE_FILE` follows, for the
 * same reason: a root that cannot be found cannot be migrated, and a workspace
 * that stops resolving the moment its owner upgrades is a wall with no door.
 * `#cli/workspace-home-migrate.ts` is what moves it.
 */
export const LEGACY_LINK_DIR = '.lanes-link';

/** This CLI's room inside the Lanes home. */
export const LINK_DIR = 'link';

/**
 * Everything here is a pure function of three inputs, all injectable.
 *
 * Not for tidiness: `bun test` runs from the checkout, so the whole suite is in
 * dev mode by the rule below, and a test that could not pin these would be
 * asserting against wherever the runner happened to be installed.
 */
export interface HomeOptions {
  readonly env?: Record<string, string | undefined>;
  /** `$HOME`. */
  readonly home?: string;
  /** The directory to judge dev mode from. Defaults to this module's own. */
  readonly dir?: string;
}

/**
 * Where Lanes Link itself is installed — the directory with `package.json`,
 * and with it `skills/` and `docs/`.
 *
 * Not the workspace: this is the code, not the operator's data. Found by
 * walking up rather than by counting `..` segments, because the count is a
 * function of where the calling file sits and a file that moves one level takes
 * a silently wrong path with it. Both callers had already been through that
 * once.
 *
 * It lives here rather than in `#profile` — where it was, and from where it is
 * still re-exported — because dev mode is a question about the install, and the
 * component that answers "where does Lanes keep things" is the one that has to
 * know where the code came from.
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
 * Whether this is a checkout rather than a published install.
 *
 * **The signal is `tsconfig.json` at the install root**, which is in neither
 * `package.json`'s `files` array nor the Dockerfile's `COPY`, so it exists in a
 * checkout and nowhere else.
 *
 * The obvious alternative — is the install root under `node_modules`, which is
 * what `updatePlan` asks — cannot be used here, and the reason is worth
 * recording because the two now disagree on one case. `bun link` symlinks the
 * *directory* `node_modules/@lanes-sh/link` at a checkout, and `bin/lanes`
 * resolves its path logically rather than with `-P`, so the install root of a
 * bun-linked checkout is a path containing `node_modules`. Deciding where
 * somebody's credentials live on a resolver detail like that is not a trade
 * worth making; a file that is either in the tarball or not is.
 *
 * `.git` was the other candidate and is rejected for the reason `updatePlan`
 * gives against it: a tarball could carry one and a shallow export could lack it.
 *
 * `LANES_LINK_DEV` overrides in both directions, and both are used. `=1` gets a
 * scratch home out of an installed copy; `=0` is what lets a checkout reach a
 * real deployment on purpose, which is the one legitimate reason to want the
 * old behaviour back.
 */
export function isDevInstall(options: HomeOptions = {}): boolean {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const flag = env['LANES_LINK_DEV'];

  // An exported-but-empty variable is a shell artefact, not an answer. Treating
  // it as `true` would put anyone with `export LANES_LINK_DEV=` in a scratch
  // home with no way to see why.
  if (flag !== undefined && flag !== '') return !(flag === '0' || flag === 'false');

  // This module's own path, not the process's cwd or argv: those describe where
  // the command was typed, and the question is where the code came from.
  try {
    return existsSync(join(installRoot(options.dir ?? import.meta.dir), 'tsconfig.json'));
  } catch {
    // No `package.json` above us at all. Not a checkout by any reading, and not
    // a reason to fail a command that was only asking where to look for a file.
    return false;
  }
}

/** `~/.lanes`, or `~/.lanes-dev` out of a checkout. */
export function lanesHome(options: HomeOptions = {}): string {
  return join(options.home ?? homedir(), isDevInstall(options) ? LANES_DEV_DIR : LANES_DIR);
}

/** `~/.lanes/link` — where a workspace lives when nothing else names one. */
export function defaultWorkspaceRoot(options: HomeOptions = {}): string {
  return join(lanesHome(options), LINK_DIR);
}

/**
 * `~/.lanes-link`, wherever it still is.
 *
 * Not under `lanesHome`, and that is the point: there was never a dev copy of
 * this, so it is composed from `$HOME` directly. A checkout asking for it is
 * asking about the operator's real workspace, which is why `homeWorkspaceRoot`
 * refuses to return it in dev mode.
 */
export function legacyWorkspaceRoot(options: HomeOptions = {}): string {
  return join(options.home ?? homedir(), LEGACY_LINK_DIR);
}

/**
 * The workspace root under `$HOME`, for a command that found none anywhere else.
 *
 * The last step of `resolveWorkspaceRoot`'s chain, which used to be one line
 * returning `~/.lanes-link`. It is three answers now, and which one it gives is
 * the whole of what moving the workspace into `~/.lanes` costs:
 *
 *  - **`~/.lanes/link` when a workspace is there**, which is the answer after a
 *    migration and on every install that never had the old one.
 *  - **`~/.lanes-link` when one is there instead** and this is not a checkout.
 *    Recognised, never written. Somebody who upgrades and does not run `update`
 *    still has a workspace, and `update` and `doctor --fix` still have something
 *    to find and move.
 *  - **`~/.lanes/link` otherwise**, so a fresh install creates the new one.
 *
 * **`isWorkspace` is a marker-file test, not a directory test**, and passing it
 * in is what keeps this component free of `#profile`. The distinction is not
 * pedantry: `~/.lanes` already belongs to the desktop app, so a bare
 * `~/.lanes/link` directory can come into existence without this CLI having put
 * a workspace in it — and an interrupted copy leaves exactly that. A directory
 * test would then prefer the empty new root, report "no profiles here", and
 * leave the intact old one unreachable by the command that migrates it.
 *
 * The checkout condition is not a detail either. Falling back onto the
 * operator's real `~/.lanes-link` from a worktree is precisely the accident dev
 * mode exists to stop, and a legacy root that outlived its migration would be a
 * standing invitation to it.
 */
export function homeWorkspaceRoot(
  isWorkspace: (directory: string) => boolean,
  options: HomeOptions = {},
): string {
  const preferred = defaultWorkspaceRoot(options);
  if (isWorkspace(preferred)) return preferred;

  const legacy = legacyWorkspaceRoot(options);
  if (!isDevInstall(options) && isWorkspace(legacy)) return legacy;

  return preferred;
}
