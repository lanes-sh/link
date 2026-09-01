import {
  listProfiles,
  readWorkspace,
  noProfileNamed,
  noTargetNamed,
  readRegistry,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import type { Flags } from './argv.ts';
import { EXPLICIT_WORKSPACE, dispatchWillRefuse, requirementFor, selectionKey } from './selection.ts';
import { refuseIfUnmigrated } from './workspace-migrate.ts';

/**
 * Refusing a command that has not said what it acts on.
 *
 * Apart from `selection.ts`, which holds the two tables — what each command
 * requires, and which flags it accepts — and argues for keeping *those two*
 * together. This is the third thing: actually resolving a selection, which under
 * ADR-052 means reading the registry, following a pointer to the workspace that
 * declares the target, and listing the profiles that live there. Table lookups
 * and network reads are not the same job, and the file-size budget noticed
 * before anyone else did.
 */

/**
 * Refuse before the command runs, naming what it wants and what there is.
 *
 * Async, and it reads the workspace — but only on the way to throwing. The
 * useful half of "which profile did you mean" is the list of them, and the same
 * for targets; a refusal that only restates the flag name leaves someone to go
 * and look it up. Both messages come from `#profile` so this file and the
 * resolver cannot describe the same refusal differently, and both name an
 * exported variable that no longer counts — the shell still configured for the
 * old world is the state hardest to diagnose from the inside.
 */
export async function requireSelection(
  first: string,
  second: string | undefined,
  flags: Flags,
  env?: Record<string, string | undefined>,
): Promise<void> {
  if (dispatchWillRefuse(first, second)) return;

  const needs = requirementFor(first, second);
  if (needs === 'none') return;

  const root = resolveWorkspaceRoot(env ? { env } : {});

  // **Workspace before profile, for both levels.** It used to ask for the
  // profile and read that profile's own target list — the ordering ADR-052
  // inverted, since a profile lives inside a workspace and there is nowhere to
  // look for one until the workspace is known. `refuseIfUnmigrated` is on the
  // refusal path only, so it costs nothing when the flag is present.
  if (typeof flags['workspace'] !== 'string') {
    const fallback = EXPLICIT_WORKSPACE.has(selectionKey(first, second))
      ? undefined
      : (await readWorkspace(root))?.default_workspace;

    if (fallback === undefined) {
      await refuseIfUnmigrated(root);
      throw noTargetNamed(await readRegistry(root), root, env, {
        refusedDefault: EXPLICIT_WORKSPACE.has(selectionKey(first, second)),
      });
    }

    // Written back onto the flags so every command downstream reads one key and
    // cannot tell a default from a typed flag — the difference belongs in the
    // line printed above the output, not in thirty call sites (ADR-061).
    flags['workspace'] = fallback;
    defaulted.add(fallback);
  }

  // A named workspace the registry cannot know, because it does not exist yet.
  if (!(flags['workspace'] in (await readRegistry(root)))) await refuseIfUnmigrated(root);

  if (needs === 'workspace') return;

  if (typeof flags['profile'] !== 'string') {
    // Listed from the target's own workspace, so the names offered are ones that
    // command could act on. An unreachable pointer degrades to the empty list
    // rather than failing — "which profile" is still the question being asked.
    const where = await resolveTargetWorkspace(root, flags['workspace'] as string).catch(() => root);
    throw noProfileNamed(where, await listProfiles(where).catch(() => []), env);
  }
}

/**
 * Flags every command accepts, whatever it does.
 *
 * `--help` short-circuits before dispatch, and `--json` is offered widely enough
 * that listing it per command would be noise. `--quiet` is read by `announce`
 * rather than by any one command.
 */

/**
 * Workspaces resolved from `default_workspace` rather than from a flag.
 *
 * A set rather than a boolean because `announce` is called from thirty places
 * and none of them threads a resolution result through — and because the thing
 * being remembered is small, true for one run, and read exactly once per line
 * of output. If the echo is ever dropped for tidiness, ADR-061 has been
 * reversed: the printed line is the whole of what makes a sticky default
 * different from the dotfile nothing prints.
 */
const defaulted = new Set<string>();

export function wasDefaulted(workspace: string): boolean {
  return defaulted.has(workspace);
}
