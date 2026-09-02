import type { Contract3Migration } from '../contract3.ts';
import type { Contract4Migration } from '../contract4.ts';

/**
 * What each contract migration did, as `update` reports it.
 *
 * Split from `update.ts` so that file stays inside the size budget, and on the
 * seam it already had: that file decides *whether* to migrate and this says
 * *what happened*. Kept beside it rather than beside the migrations, because
 * `doctor --fix` renders the same facts its own way and the two are allowed to
 * read differently — what they may not do is disagree about which of them is
 * worth mentioning.
 */

/**
 * What contract 4 did, and the one part of it that is the operator's.
 *
 * `update` reported nothing, so the shared-store duplication happened in
 * silence — a decision the migration calls the owner's, and which `doctor --fix`
 * prints. Two paths disagreeing on that is how one becomes the wrong one to run.
 */
export function sayContract4(migration: Contract4Migration, say: (line: string) => void): void {
  say(
    `migrated ${migration.profiles.length} profile(s) to contract 4 — a profile owns its data ` +
      'again, and Lanes\u2019 own surfaces are lanes_memory, lanes_tasks and the rest',
  );
  for (const change of migration.changes) say(`  ${change}`);

  if (migration.shared.length > 0) {
    say('  A store more than one profile granted was copied into each, and the original kept.');
    say('  Deleting what you do not want is the one step here that is yours.');
  }

  if (migration.orphaned.length > 0) {
    say('  What no profile grants was left exactly where it is, and named above.');
  }

  say('  Every registered client caches its tool list, so re-add them: lanes link mcp add');
}

export function sayContract3(migration: Contract3Migration, say: (line: string) => void): void {
  say(
    `migrated ${migration.profiles.length} profile(s) to contract 3 — connections belong to the ` +
      'workspace now, and a profile grants them one by one',
  );
  for (const change of migration.changes) say(`  ${change}`);

  if (migration.renames.length > 0) {
    say('  Two profiles named different accounts with the same id, so one was renamed.');
    say('  Check the grants in each profile before running an agent against them.');
  }

  say(`  The old per-profile credential stores are left in place; remove them once this works.`);
}
