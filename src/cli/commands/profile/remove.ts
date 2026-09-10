import {
  ConfigError,
  WORKSPACE_FILE,
  loadWorkspaceProfiles,
  openTarget,
  readWorkspace,
  readWorkspaceFile,
  workspaceFiles,
  workspacePath,
  writeWorkspaceFile,
} from '#profile';
import { parseDocument } from 'yaml';
import { rm } from 'node:fs/promises';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { confirmedByName } from './confirm.ts';
import { recordConfigChange } from '../../audit-change.ts';
import { nextAfterEdit, publishProfileEdit } from '../../publish.ts';
import { announceProfile, emit, print, style } from '../../output.ts';
import {
  locateProfile,
  openBlobStoreFor,
  openSecretStoreFor,
  type GlobalFlags,
} from '../../runtime.ts';
import { executeRemoval, renderOutcome, retryCommand } from './perform.ts';
import { removalPlan } from './removal.ts';
import { renderPlan } from './preview.ts';
import { removalSubject, subjectOf } from './subject.ts';
import { settleDisposition } from './disposition.ts';

/**
 * `lanes link profile remove`, and the one thing it must never refuse.
 *
 * The command resolves the profile by *existence* and reads its config
 * separately, because until it did, a `profile.yaml` the schema refused could
 * be listed and never removed: every command that might have taken it away
 * parsed it first and died on the same error, so the only way out was deleting
 * the file by hand — or the bucket object, on a deployed workspace (#219).
 *
 * What makes that safe is in `subject.ts`, and it is one property: a field the
 * file did not yield removes a line from the plan and can never add a wrong
 * one. The preview says so before anything is confirmed, and anything this
 * could not see is reported and carried into the exit code.
 */

export interface RemoveFlags extends GlobalFlags {
  readonly dryRun?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly json?: boolean | undefined;
  /** Delete this profile's memory, tasks, assets, entities, vault and skills. */
  readonly deleteData?: boolean | undefined;
  /** Move them into this profile instead. */
  readonly migrateTo?: string | undefined;
  /** Injected by a caller that has already asked — the console, and tests. */
  readonly prompter?: Prompter | undefined;
}


/**
 * `lanes link profile remove <name>` — the profile, and everything it owns.
 *
 * Deliberately not reachable from MCP. This writes credentials and mutates
 * config, which ADR-007 keeps CLI-only, and it is the most destructive thing
 * in the tool.
 */
export async function removeProfile(name: string, flags: RemoveFlags): Promise<void> {
  // Located, not resolved. Everything up to and including finding the file
  // throws exactly as it always did — a workspace that is not declared, a
  // pointer that will not follow, a profile that is not there. Only the *parse*
  // is allowed to fail softly, and only here. A `try` around the whole
  // resolution would have read "you typed the wrong workspace" as "this profile
  // is broken", and `--yes --delete-data` would then have run a removal to
  // completion somewhere nobody meant.
  const found = await locateProfile({ ...flags, profile: name });
  announceProfile(found.selection);

  const subject = await removalSubject(found);
  const target = found.target;
  const root = found.selection.workspaceRoot;
  const files = workspaceFiles(root);
  const { declared } = await openTarget(root, target);

  const prompter = flags.prompter ?? terminalPrompter;
  const someoneToAsk = flags.prompter ? prompter.interactive : process.stdin.isTTY;
  const disposition = await settleDisposition(
    name,
    flags,
    prompter,
    someoneToAsk,
    migrationRefusal(subject.config === null, name, target),
  );

  if (disposition === null) {
    print(style.dim('  cancelled — nothing was removed'));
    return;
  }

  if (disposition.kind === 'migrate') {
    // Before the plan, because a plan against a profile that does not exist
    // would name destinations nothing will ever read.
    const staying = (await loadWorkspaceProfiles(root)).loaded.map((one) => one.profile);
    if (disposition.into === name || !staying.includes(disposition.into)) {
      throw new ConfigError(
        `Cannot migrate "${name}" into "${disposition.into}".\n` +
          `  Staying: ${staying.filter((one) => one !== name).join(', ') || 'nothing'}`,
      );
    }
  }

  const plan = await removalPlan(subject, root, name, {
    target,
    declared,
    disposition,
    openSecrets: (target) => openSecretStoreFor(root, target),
    openBlobs: (target, area) => openBlobStoreFor(name, root, target, area),
    readDefaultProfile: async () => (await readWorkspace(root))?.default_profile,
    // What the workspace keeps. The credential store is one file for all of
    // them now, so anything a survivor declares is not this removal's to delete.
    // Survivors always parse — `loaded` is the ones that did — so the kept set
    // is exact even when the subject's own file is not.
    survivors: (await loadWorkspaceProfiles(root)).loaded
      .filter((one) => one.profile !== name)
      .map((one) => subjectOf(one.config)),
  });

  renderPlan(plan);

  if (flags.dryRun) {
    print(style.dim('  --dry-run: nothing was removed, and no store was written to.'));
    print();
    return emit(flags.json, plan, () => {});
  }

  if (!(await confirmedByName(name, { yes: flags.yes, prompter: flags.prompter }))) return;

  const outcome = await executeRemoval(plan, {
    openSecrets: (target) => openSecretStoreFor(root, target),
    openBlobs: (target, area) => openBlobStoreFor(name, root, target, area),
    removeConfig: async (path) => await files.delete(relativeToRoot(root, path)),
    removeDirectory: async (path) => await rm(workspacePath(root, path), { recursive: true, force: true }),
    clearDefaultProfile: async () => await clearDefault(root),
    retry: retryCommand,
  });

  // Before the render, and against what was read above — the profile's file is
  // gone by now, so a helper that re-read it would find nothing. A removal
  // whose config would not load records the row anyway, without the connection
  // list it could not read: the removal that most deserves a row is the one
  // nothing could account for.
  await recordConfigChange(name, root, target, {
    capability: 'config.profile.remove',
    scope: name,
    arguments: subject.config
      ? { connections: subject.config.grants.map((grant) => grant.connection) }
      : { unreadable: subject.refusal ?? 'the config would not load' },
  });

  // And the endpoint is told, as it is told about every other config edit
  // (ADR-074) — but more urgently than any of them. It holds the profiles it
  // listed at boot, so without this a profile that has been *removed*, with its
  // credentials and its stores deleted, stayed reachable until the revision
  // happened to restart: the operator believing they had revoked something they
  // had not.
  //
  // **A config that will not load today is not a profile that was never
  // served**, which is the reading that would make skipping this look safe. The
  // set is built at boot and at `/reload` and at no other time, so a file that
  // parsed at the last boot is being served right now, from memory, with live
  // credentials — and this reload is the only thing that drops it before a
  // restart. So the notify matters *more* here, not less.
  //
  // Wrapped because the removal has already happened and a failure to announce
  // it cannot undo it; `publishWorkspace` copies what the local store has, which
  // no longer includes this profile, so nothing here can put the file back. A
  // throw is reported as nothing — `renderOutcome` owns the exit code, derived
  // from what survived on the stores.
  let published: string | undefined;
  try {
    const resolution = { workspaceRoot: root, profile: name };
    const config = subject.config ?? undefined;
    published = nextAfterEdit(await publishProfileEdit({ resolution, config, target }));
  } catch {
    // See above.
  }

  return emit(flags.json, { ...outcome, ...(published ? { published } : {}) }, () => {
    renderOutcome(outcome);
    if (published) print(style.dim(`  ${published}`));
  });
}

/** `profiles/<name>.yaml`, however the path was spelled for display. */
function relativeToRoot(root: string, path: string): string {
  const at = path.indexOf('profiles/');
  return at === -1 ? path.replace(`${root}/`, '') : path.slice(at);
}

/**
 * Clear the key, never repoint it.
 *
 * Choosing a new default on the operator's behalf would silently change what
 * every other command in that workspace acts on — the one thing a removal
 * should not decide for them.
 */
async function clearDefault(root: string): Promise<void> {
  const text = await readWorkspaceFile(workspaceFiles(root), WORKSPACE_FILE);
  if (text === null) return;

  const document = parseDocument(text);
  document.delete('default_profile');
  await writeWorkspaceFile(workspaceFiles(root), WORKSPACE_FILE, String(document));
}

/**
 * Why a broken profile's bytes will not be moved into a working one.
 *
 * Not because the mechanics fail — `migratesAcross` is a key-prefix test and
 * `resolveCollisions` opens the destination by name, so both work perfectly well
 * here. It is the asymmetry in what going wrong costs. `--delete-data` fails
 * toward having deleted less than it should, which is the direction everything
 * else in this design already leans. `--migrate-to` fails toward putting bytes
 * nobody could account for into a profile that is currently correct, under a
 * connection it may not even grant — invisible to every command that reads it,
 * and with nothing to undo it.
 */
function migrationRefusal(degraded: boolean, name: string, target: string): string | undefined {
  if (!degraded) return undefined;

  return (
    `"${name}"'s config will not load, so this will not move its bytes into another profile. ` +
    'Which connection each note sits under is something only that file says — and a note ' +
    'arriving under a connection the destination does not grant is invisible to every command, ' +
    'in a profile that is currently correct.\n' +
    `  See what is there:  lanes link profile remove ${name} --workspace ${target} --dry-run\n` +
    `  Remove it as it is: lanes link profile remove ${name} --workspace ${target} --delete-data`
  );
}
