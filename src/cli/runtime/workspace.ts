import { ConfigError, listProfiles, openTarget, resolveWorkspaceRoot } from '#profile';
import { openRuntime, type Runtime } from './open.ts';
import type { GlobalFlags } from './select.ts';

/**
 * A runtime for a workspace, when the command does not act on one profile.
 *
 * Contract 3 moved the credential store, the audit log, the state store and the
 * blob root up to the workspace, so a command that opens any of them opens the
 * same thing whichever profile it was handed. `openRuntime` still wants one,
 * because a `Runtime` carries a resolved profile — so this picks one rather
 * than making the caller ask a question with no answer.
 *
 * `--profile` still narrows where narrowing means something: the audit log is
 * one chain and the flag filters it, rather than selecting which log to read.
 * What it must never do is *decide* anything, which is why the profile chosen
 * here when none is given is simply the first and is never reported as though
 * it were the subject.
 */
export async function openWorkspaceRuntime(flags: GlobalFlags): Promise<Runtime> {
  if (flags.profile !== undefined) return openRuntime(flags);

  const root = resolveWorkspaceRoot();
  const resolved = await openTarget(root, flags.target!);
  const names = await listProfiles(resolved.workspaceRoot);

  if (names.length === 0) {
    throw new ConfigError(
      `Workspace "${flags.target}" holds no profiles, so there is nothing to open.\n` +
        `  Create one with: lanes link profile add <name> --workspace ${flags.target}`,
    );
  }

  return openRuntime({ ...flags, profile: names[0]! });
}

/**
 * Which profile a workspace-level command should act *as*.
 *
 * Distinct from `openWorkspaceRuntime` because the caller needs the name rather
 * than a runtime — `start` puts it back into flags and hands them on. Same rule:
 * `--profile` wins, and otherwise the first is taken without being reported as
 * a choice, because for the things this is used for it is not one.
 */
export async function primaryProfile(flags: GlobalFlags): Promise<string> {
  if (flags.profile !== undefined) return flags.profile;

  const root = resolveWorkspaceRoot();
  const resolved = await openTarget(root, flags.target!);
  const names = await listProfiles(resolved.workspaceRoot);

  if (names.length === 0) {
    throw new ConfigError(
      `Workspace "${flags.target}" holds no profiles, so there is nothing to serve.\n` +
        `  Create one with: lanes link profile add <name> --workspace ${flags.target}`,
    );
  }

  return names[0]!;
}
