import {
  CONNECTIONS_FILE,
  listProfiles, ConfigError, resolveSelection, resolveTargetWorkspace, resolveWorkspaceRoot,
  SUPPORTED_CONTRACT } from '#profile';
import { ConfigDocument } from '../../config-edit.ts';
import { migrateRenamedProviders, pendingRenames, shapeOf } from '../../config-migrate.ts';
import { migrateToCurrentContract } from '../../workspace-migrate.ts';
import { emit, fail, ok, print, style, warn } from '../../output.ts';
import { openSecretStoreFor, type GlobalFlags } from '../../runtime.ts';

/**
 * `doctor` answering for a profile whose config will not load.
 *
 * Here rather than in `inspect.ts` because it is the opposite of everything
 * there: every other check reads a runtime, and this one runs precisely when no
 * runtime can be opened. Keeping it beside them would have put a second
 * `try`/`catch` shape around a file that is otherwise one long list of findings.
 *
 * Why `doctor` at all, and not a command of its own: it is already the command
 * whose job is to say what is wrong and name the fix, and a `lanes link migrate`
 * would be a command an operator has to know exists before their config breaks.
 * `doctor` is what someone runs when something is broken, so it has to be the
 * one that works when everything else refuses.
 */

export interface RenameFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  /** Apply the migration rather than reporting it. */
  readonly fix?: boolean | undefined;
}

/**
 * Whether a refusal to load was a provider rename, and — with `--fix` — undo it.
 *
 * Returns false for anything else, so the caller rethrows the original error
 * rather than replacing a real config problem with "nothing to migrate".
 *
 * The selection is resolved again here, and cheaply: `resolveSelection` reads
 * the workspace and the flag, never a profile's config, which is what makes it
 * usable on the path where the config is the thing that is broken.
 */
export async function migratedRenamedProviders(
  flags: RenameFlags,
  refusal: unknown,
): Promise<boolean> {
  if (!(refusal instanceof ConfigError)) return false;

  // **The target's workspace, not this machine's.** `resolveSelection` defaults
  // to the local root, which is where this looked before ADR-052 — and there was
  // only one place a profile could be. The row that needs renaming is in the
  // file the *named target* holds, so a bucket's stale row was invisible from
  // here while the refusal kept naming this command as the fix.
  const target = flags.target ?? '';
  const localRoot = resolveWorkspaceRoot();
  const root = await resolveTargetWorkspace(localRoot, target).catch(() => localRoot);

  const selection = await resolveSelection({ profileFlag: flags.profile, root });

  // The rename is a property of the *connection*, so it is found in the
  // workspace's file (ADR-057) — and applied across every profile, because any
  // of them may grant the row being renamed.
  const document = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
  if (pendingRenames(document).length === 0) return false;

  const profiles: ConfigDocument[] = [];
  for (const name of await listProfiles(root)) {
    profiles.push(await ConfigDocument.open(root, name));
  }

  // Shape-only, because the check this document fails runs after the schema.
  // Throws when it is malformed beyond a rename, which is a better sentence
  // than the referential one it would otherwise be reported under.
  const config = shapeOf(await ConfigDocument.open(root, selection.profile));
  const credentials = await openSecretStoreFor(config, root, target);

  const migration = await migrateRenamedProviders(document, profiles, credentials, {
    apply: flags.fix === true,
  });

  const applied = flags.fix === true && migration.changes.length > 0;

  // A report is a problem, because the profile is still unusable. A repair that
  // left nothing behind is not, and one that could not decide every row is —
  // those rows are exactly as broken as before.
  if (!applied || migration.blocked.length > 0) process.exitCode = 1;

  await emit(
    flags.json,
    {
      ok: applied && migration.blocked.length === 0,
      profile: selection.profile,
      target,
      workspace: root,
      applied,
      rows: migration.rows,
      changes: migration.changes,
      blocked: migration.blocked,
    },
    () => {
      print(`profile ${style.bold(selection.profile)}  target ${style.bold(target)}`);
      print();

      if (applied) {
        print(ok(`${document.path} no longer names a provider that has moved`));
      } else {
        print(fail(`${document.path} names a provider that has moved, so nothing can load it`));
      }

      for (const change of migration.changes) {
        print(`      ${style.dim(applied ? change : `would ${change}`)}`);
      }
      for (const problem of migration.blocked) print(warn(problem));

      if (!applied && migration.changes.length > 0) {
        print();
        print(`Run the same command with ${style.bold('--fix')} to apply it.`);
      }
    },
  );

  return true;
}


/**
 * Whether a refusal to load was a stale contract, and — with `--fix` — raise it.
 *
 * The sibling of `migratedRenamedProviders` above, and asked *before* it: a
 * contract-1 profile is refused by `assertSupportedContract`, which runs before
 * the schema, so a file with both problems reports this one and the rename is
 * invisible until it is fixed.
 *
 * Here for the reason this file's header already gives — `doctor` is what
 * someone runs when something is broken, so it has to be the command that works
 * when everything else refuses. `update` migrates the local workspace on its own
 * and most people will never reach this; the ones who do are the ones whose
 * `--target` is a bucket, which `update` deliberately leaves alone.
 *
 * **It will migrate a remote workspace, and says what that costs.** The endpoint
 * in front of a bucket runs a pinned image, and one built before contract 2
 * cannot read what this writes. That is a real consequence and it is the
 * operator's to accept, so the line naming the redeploy is printed whether or
 * not `--fix` was passed.
 */
export async function migratedContract(flags: RenameFlags, refusal: unknown): Promise<boolean> {
  if (!(refusal instanceof ConfigError)) return false;

  const root = resolveWorkspaceRoot();
  const target = flags.target ?? '';
  // Where the profiles actually are. For a pointer that is the bucket, which is
  // the case this exists for; a target the registry cannot resolve is not a
  // migration problem and falls through to the original refusal.
  const where = await resolveTargetWorkspace(root, target).catch(() => null);
  if (where === null) return false;

  // Running the migration is how "is there anything to do" is answered, rather
  // than a predicate beside it. The predicate was `needsMigration`, which asks
  // only about contract 1 — so a contract-2 bucket, the exact thing this
  // function exists to rescue, returned false here and fell through to the
  // refusal it was supposed to fix. With `--fix` absent this writes nothing.
  const migration = await migrateToCurrentContract(where, { apply: flags.fix === true });
  if (migration.alreadyCurrent) return false;

  const applied = flags.fix === true;
  const remote = where !== root;

  if (!applied) process.exitCode = 1;

  await emit(
    flags.json,
    {
      ok: applied,
      workspace: where,
      target,
      applied,
      remote,
      profiles: migration.profiles,
      targets: migration.targets,
      changes: migration.changes,
    },
    () => {
      print(`workspace ${style.bold(where)}  target ${style.bold(target)}`);
      print();
      print(
        applied
          ? ok(`migrated to contract ${SUPPORTED_CONTRACT} — a workspace declares its own adapters, and holds the connections a profile grants`)
          : warn(`this workspace is behind contract ${SUPPORTED_CONTRACT}, and nothing here reads that any more`),
      );
      for (const change of migration.changes) print(`  ${change}`);

      if (remote) {
        print();
        print(
          style.dim(
            applied
              ? '  The endpoint serving this bucket is running an older image and cannot read\n' +
                `  what was just written. Roll a new one: lanes link deploy --workspace ${target}`
              : `  lanes link deploy --workspace ${target} migrates it and ships the image that\n` +
                '  understands it, in one step. Prefer that to --fix here.',
          ),
        );
        return;
      }

      if (!applied) print(style.dim(`  Fix it with: lanes link doctor --fix --workspace ${target}`));
    },
  );

  return true;
}
