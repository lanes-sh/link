import { ConfigError } from '#profile';
import type { BlobStore } from '#stores/blobs';

/**
 * Moving objects between two layouts, without losing one.
 *
 * Shared by every contract migration that relocates bytes rather than YAML —
 * contract 3 hoisting a profile's data to the workspace, contract 4 carrying it
 * back into the profile. Each learned the same rules the same hard way, so they
 * live once: nothing is deleted until what replaced it has been read back, every
 * destination is checked before the first byte moves, and a rerun after an
 * interruption finishes rather than refusing.
 */

export interface Move {
  readonly from: string;
  readonly to: string;
  /**
   * Rewrite the object's bytes on the way across.
   *
   * Only a connection record needs this, and it needs it for a reason a plain
   * copy cannot serve: `ConnectionRepository.list` reads `provider` and `id`
   * out of the record *body*, not out of the key it was stored under. A renamed
   * connection whose bytes were copied verbatim would sit at
   * `connections.v1/vault.work` still calling itself `vault.main`, and the next
   * `upsert` would write a second record beside it.
   */
  readonly rewrite?: (data: Uint8Array) => Uint8Array;
  /**
   * Write only where the destination is empty; leave the source alone if not.
   *
   * For the objects two profiles can legitimately both hold — a connection they
   * share, a provider-keyed cache, one custom manifest — where a second copy is
   * a duplicate rather than a clash. `claim` drops the loser within one run, but
   * deletes the winner's source and leaves the loser's: the rerun then saw a
   * different first claimant, found foreign bytes at the destination, and threw,
   * permanently. `rewriteProfiles` stamps the contract *after* the moves, so an
   * interruption during them forces exactly that rerun.
   */
  readonly whenAbsent?: boolean;
}

/**
 * Two objects aimed at one key, caught while this is still a plan.
 *
 * `applyMoves` checks the destination per object as well, but that check cannot
 * see a collision between two objects *in this run* once the moves are applied
 * concurrently — both would look at an absent destination and both would write.
 * Hoisting it here also puts it where this file says it belongs: everything that
 * can fail happens before the first byte moves, so a refusal leaves the
 * workspace exactly as it was.
 */
export function assertOneObjectPerDestination(moves: readonly Move[]): void {
  const seen = new Map<string, string>();

  for (const move of moves) {
    const first = seen.get(move.to);
    if (first !== undefined) {
      throw new ConfigError(
        `Two objects want to be at ${move.to}, and this migration cannot merge them.\n` +
          `  ${first} and ${move.from}. Nothing has been written.\n` +
          '  Please report it with the layout of your data directory.',
      );
    }
    seen.set(move.to, move.from);
  }
}

/** First claim on a destination wins; a later one is left where it is. */
export function claim(claimed: Set<string>, move: Move): Move | null {
  if (claimed.has(move.to)) return null;
  claimed.add(move.to);
  return { ...move, whenAbsent: true };
}

/**
 * How many objects are in flight at once.
 *
 * Serial was fine while this only ever ran against a local disk. A deployed
 * workspace's audit log is one object per event, so the first real bucket this
 * migrated held 1,906 of them — three round trips each, in series, is minutes of
 * a deploy spent with nothing on screen. The same 16 the read paths in
 * `#providers/memory` and `#providers/tasks` settled on, and for the same
 * reason: enough to hide the latency, not enough to look like an incident to the
 * other end.
 *
 * Safe to widen only while each move stays independent, which is what
 * `assertOneObjectPerDestination` guarantees.
 */
const MOVE_CONCURRENCY = 16;

export async function applyMoves(files: BlobStore, moves: readonly Move[]): Promise<void> {
  const pending = moves.filter((move) => move.from !== move.to);

  for (let start = 0; start < pending.length; start += MOVE_CONCURRENCY) {
    await Promise.all(
      pending.slice(start, start + MOVE_CONCURRENCY).map((move) => applyMove(files, move)),
    );
  }
}

/** One object, moved or finished. Never deletes before the copy reads back. */
async function applyMove(files: BlobStore, move: Move): Promise<void> {
  const source = await files.get(move.from);
  if (source === null) return;

  // Before the comparison below as well as before the write. Comparing the
  // *source* bytes against a destination that holds the rewritten ones would
  // read an already-finished move as a collision, and refuse the one rerun this
  // file promises.
  const data = move.rewrite === undefined ? source : move.rewrite(source);

  if (await files.has(move.to)) {
    const held = await files.get(move.to);

    // Raced away between the two calls, so there is nothing there after all and
    // the ordinary path below is still the right one.
    if (held !== null) {
      // Another instance of the same connection, or another profile's copy of
      // one shared cache, got there first. Left where it is rather than
      // refused — and rerunnable, which is the whole point.
      if (!sameBytes(held, data)) {
        if (move.whenAbsent === true) return;
        throw new ConfigError(
          `Two objects want to be at ${move.to}, and this migration cannot merge them.\n` +
            `  ${move.from} is the second, and what is already there is not a copy of it.\n` +
            '  Nothing has been deleted. Please report it with the layout of your data ' +
            'directory.',
        );
      }

      // Already copied, by a run that did not get to the delete.
      await files.delete(move.from);
      return;
    }
  }

  await files.put(move.to, data);
  if ((await files.get(move.to)) === null) {
    throw new ConfigError(
      `${move.to} did not read back after being written. Nothing has been deleted; ` +
        `fix the store and run this again.`,
    );
  }

  await files.delete(move.from);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
