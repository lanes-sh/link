import { ConfigError, resolveSelection } from '#profile';
import { ConfigDocument } from '../../config-edit.ts';
import { migrateRenamedProviders, pendingRenames, shapeOf } from '../../config-migrate.ts';
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

  const selection = await resolveSelection({ profileFlag: flags.profile });
  const document = await ConfigDocument.open(selection.workspaceRoot, selection.profile);
  if (pendingRenames(document).length === 0) return false;

  // Shape-only, because the check this document fails runs after the schema.
  // Throws when it is malformed beyond a rename, which is a better sentence
  // than the referential one it would otherwise be reported under.
  const config = shapeOf(document);
  const target = flags.target ?? '';
  const credentials = await openSecretStoreFor(config, selection.workspaceRoot, target);

  const migration = await migrateRenamedProviders(document, credentials, {
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
