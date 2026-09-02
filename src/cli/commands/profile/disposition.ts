import { ConfigError } from '#profile';
import type { Prompter } from '../../prompt.ts';

/**
 * What becomes of the bytes a removed profile owns.
 *
 * Split from `removal.ts` and `remove.ts` on the seam the question already has:
 * both files grew past the size budget when this arrived, and it is one
 * decision — asked once, answered once, and then applied by the plan and the
 * execution without either re-deciding anything.
 */

/**
 * What to do with the bytes a profile owns.
 *
 * There has to be an answer and there is no safe default, which is why this is
 * a discriminated choice rather than a flag with a fallback. Deleting by
 * default destroys the material somebody kept; migrating by default puts one
 * profile's notes into another without being asked, which is the thing ADR-066
 * exists to stop happening by accident.
 */
export type Disposition =
  | { readonly kind: 'delete' }
  | { readonly kind: 'migrate'; readonly into: string };

/**
 * `note.md` becomes `note-2.md`, before the extension rather than after it.
 *
 * An asset's key is whatever the file was called, and `note.md-2` is a file
 * nothing will open. Memory entries and tasks are `<id>.md`, so the same rule
 * keeps the id readable.
 */
export function suffixed(key: string, taken: (candidate: string) => boolean): string {
  const dot = key.lastIndexOf('.');
  const cut = dot <= key.lastIndexOf('/') ? key.length : dot;
  const [stem, extension] = [key.slice(0, cut), key.slice(cut)];

  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${extension}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * What to do with the bytes, decided before anything is planned.
 *
 * **`--yes` does not imply a disposition.** Everything else `--yes` skips is a
 * confirmation of something the command was already told to do; this is a
 * question it has not been asked, and picking either answer silently is a way
 * to lose somebody's notes — or to put them somewhere they did not ask for
 * them, which under ADR-066 is the failure the whole change exists to prevent.
 * So a non-interactive caller must say, and one that does not is refused with
 * both spellings named.
 */
export async function settleDisposition(
  profile: string,
  flags: { readonly deleteData?: boolean | undefined; readonly migrateTo?: string | undefined },
  prompter: Prompter,
  someoneToAsk: boolean,
): Promise<Disposition | null> {
  if (flags.migrateTo !== undefined && flags.deleteData === true) {
    throw new ConfigError(
      '--delete-data and --migrate-to say opposite things about the same bytes. Pass one.',
    );
  }

  if (flags.migrateTo !== undefined) return { kind: 'migrate', into: flags.migrateTo };
  if (flags.deleteData === true) return { kind: 'delete' };

  if (!someoneToAsk) {
    throw new ConfigError(
      `"${profile}" owns memory, tasks, assets and skills, and this does not guess at what ` +
        'becomes of them.\n' +
        '  Say which: --delete-data, or --migrate-to <profile>',
    );
  }

  const answer = (
    await prompter.ask(
      `What becomes of ${profile}'s memory, tasks, assets and skills?\n` +
        `  [d] delete them   [m] move them into another profile   [anything else] stop: `,
    )
  ).trim().toLowerCase();

  if (answer === 'd') return { kind: 'delete' };
  if (answer !== 'm') return null;

  const into = (await prompter.ask('  Move them into which profile? ')).trim();
  return into.length === 0 ? null : { kind: 'migrate', into };
}


/**
 * Rename anything the destination already holds, before a byte moves.
 *
 * Resolved while this is still a plan, so the operator sees every rename in the
 * preview they confirm from and the execution has no decision left to make. A
 * destination that is occupied holds the *destination profile's* own note, task
 * or asset — overwriting one would be the quiet half of a migration nobody
 * asked for, and merging two is not a thing bytes can do.
 *
 * Mutates `items` in place because the caller is still assembling the plan;
 * the warnings come back for it to attach.
 */
export async function resolveCollisions(
  items: { kind: string; movedTo?: readonly [string, string]; note?: string }[],
  profile: string,
  into: string,
  open: (area: string) => Promise<{ list(): Promise<{ key: string }[]> }>,
): Promise<string[]> {
  const warnings: string[] = [];

  // **Throws rather than warning.** It returned a warning saying "nothing has
  // run" and then left every `movedTo` in place — and `executeRemoval` writes
  // each one without checking, on the stated ground that "a collision was
  // resolved while this was still a plan". With `--yes` there is no prompt to
  // stop at, so an unreadable destination meant the destination profile's own
  // notes were overwritten by the removed profile's files of the same name, and
  // the command reported success. A plan that cannot be made safe must not
  // become one.
  let held: Set<string>;
  try {
    held = new Set((await (await open(into)).list()).map((blob) => blob.key));
  } catch (cause) {
    throw new ConfigError(
      `"${profile}"'s storage could not be read (${
        cause instanceof Error ? cause.message : String(cause)
      }), so a name it already holds cannot be found — and migrating into it ` +
        'would overwrite one.\n  Nothing has run. Fix the store and try again, or pass ' +
        '--delete-data instead.',
    );
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind !== 'blob' || item.movedTo === undefined) continue;

    const key = item.movedTo[1];
    if (!held.has(key)) {
      held.add(key);
      continue;
    }

    const renamed = suffixed(key, (candidate) => held.has(candidate));
    held.add(renamed);
    items[index] = {
      ...item,
      movedTo: [into, renamed] as const,
      note: `renamed — ${profile} already holds ${key}`,
    };
    warnings.push(`${key} is already in "${profile}", so it arrives as ${renamed}.`);
  }

  return warnings;
}
