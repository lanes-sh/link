import { ConfigError, DATA_DIR, layout } from '#profile';
import type { BlobStore } from '#stores/blobs';
import { CONNECTIONS_NAMESPACE, decodeSegment, objectKey } from '#stores/state';

/**
 * The half of the contract-3 migration that moves bytes rather than YAML.
 *
 * Split from `contract3.ts` on the seam the migration already has: that file
 * decides *what* the new shape is, and this one carries the credentials and
 * objects into it. Both halves are ordered so a crash between any two steps
 * leaves a workspace that still opens, and the rule that makes that true lives
 * here — nothing is deleted until what replaced it has been read back.
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
}

/**
 * Where every object under `data/<profile>/` is going.
 *
 * Driven by `perProfile`, the per-profile map the hoist already built from old
 * key to new — because the rename that matters is *this profile's*. The first
 * version of this keyed a lookup by the hoisted (new) key and queried it with
 * the old one, which made the resolution an unconditional no-op: provider and
 * connection ids contain no dot, so anything the map returned already had the id
 * being looked up. Two profiles holding `gmail.main` for different mailboxes
 * both sent their blobs to `data/gmail/main/`, and the second one's landed in
 * the first one's namespace.
 *
 * Anything that matches no rule is left exactly where it is: this moves what it
 * understands and never deletes what it does not.
 */
export async function planMoves(
  files: BlobStore,
  profiles: readonly string[],
  perProfile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Promise<Move[]> {
  const moves: Move[] = [];
  // Destinations inside `state.kv` that an earlier profile already claimed, for
  // the two namespaces where a second claim is a duplicate rather than a
  // conflict. See `stateMove`.
  const claimed = new Set<string>();

  for (const profile of profiles) {
    const mapping = perProfile.get(profile) ?? new Map<string, string>();
    const prefix = `${DATA_DIR}/${profile}/`;

    for (const blob of await files.list(prefix)) {
      const rest = blob.key.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      if (head === undefined) continue;

      // The credential store is merged rather than moved, and the old copy is
      // deliberately left behind.
      if (head === 'credentials.enc' || head === 'credentials.enc.key') continue;

      // The instance this profile's single-instance surfaces became. Both are
      // one store per profile in contract 2 and one per *connection* in
      // contract 3, so two profiles' vaults are two documents — sending both to
      // `vault('main')` orphaned the second and silently gave it the first's,
      // which is the worst of the collisions because the wrong answer is a
      // credential (ADR-059).
      if (head === 'vault.enc') {
        moves.push({ from: blob.key, to: layout.vault(instanceOf(mapping, 'vault')) });
        continue;
      }
      if (head === 'vault.enc.key') {
        moves.push({ from: blob.key, to: `${layout.vault(instanceOf(mapping, 'vault'))}.key` });
        continue;
      }
      if (head === 'skills.d') {
        moves.push({
          from: blob.key,
          to: `${layout.skills(instanceOf(mapping, 'skills'))}/${tail.join('/')}`,
        });
        continue;
      }
      if (head === 'providers.d') {
        moves.push({ from: blob.key, to: `${layout.providers()}/${tail.join('/')}` });
        continue;
      }
      // One object per event, under a key that already carries the timestamp
      // and the profile in every record — so concatenating three profiles' logs
      // is exactly moving the objects across, with nothing to reconcile.
      if (head === 'audit.log') {
        moves.push({ from: blob.key, to: `${DATA_DIR}/audit.log/${tail.join('/')}` });
        continue;
      }
      if (head === 'state.kv') {
        const move = stateMove(blob.key, tail, mapping, claimed);
        if (move !== null) moves.push(move);
        continue;
      }

      // Otherwise it is `<provider>/<connection>/...`, the namespace every
      // provider's blobs are scoped into.
      const connection = tail[0];
      if (connection === undefined) continue;

      // This profile's old key, through this profile's mapping.
      const settled = mapping.get(`${head}.${connection}`);
      const id = settled === undefined ? connection : (settled.split('.')[1] ?? connection);
      moves.push({ from: blob.key, to: `${DATA_DIR}/${head}/${id}/${tail.slice(1).join('/')}` });
    }
  }

  assertOneObjectPerDestination(moves);
  return moves;
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
function assertOneObjectPerDestination(moves: readonly Move[]): void {
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

/**
 * Where one object under a profile's `state.kv` is going.
 *
 * `state.kv` used to be moved verbatim, on the grounds that its records "already
 * carry the profile". They do not. `connections.v1` is keyed on
 * `<provider>.<id>` — precisely what the hoist renames — so every profile's
 * owner layer wrote `connections.v1/vault.main`, and three profiles aimed three
 * objects at one key. That is the collision `assertOneObjectPerDestination`
 * called unreachable, and it was reachable from any workspace with two profiles
 * in it.
 *
 * Keys are decoded rather than pattern-matched. On disk the namespace and key
 * are percent-encoded per segment (`connections%2Ev1/vault%2Emain.json`), and
 * reassembling that by hand at this call site would be the second spelling of
 * an encoding that must have exactly one.
 *
 * `null` means leave it where it is. Nothing is deleted by not moving it, the
 * old `data/<profile>/` tree survives the migration either way, and `doctor`
 * names what is left.
 */
function stateMove(
  from: string,
  tail: readonly string[],
  mapping: ReadonlyMap<string, string>,
  claimed: Set<string>,
): Move | null {
  const here = `${layout.state()}/${tail.join('/')}`;
  const leaf = tail[tail.length - 1];

  // Not an object this module wrote: moved as it is, and still held to the
  // one-object-per-destination rule, because an unrecognised collision is a
  // thing to refuse rather than to resolve by guessing.
  if (tail.length < 2 || leaf === undefined || !leaf.endsWith('.json')) {
    return { from, to: here };
  }

  const namespace = tail.slice(0, -1).map(decodeSegment).join('/');
  const key = decodeSegment(leaf.slice(0, -'.json'.length));

  // A cache keyed on the provider id, not on a connection — so two profiles
  // that both connected the same vendor hold two entries under one key. They
  // describe the same manifest, `open.ts` treats a miss and a corrupt entry
  // alike as "not discovered yet", and `connect` refreshes it. First one wins.
  if (namespace === 'discovery') {
    return claim(claimed, { from, to: here });
  }

  if (namespace !== CONNECTIONS_NAMESPACE) return { from, to: here };

  // This profile's old key, through this profile's mapping — the same lookup
  // the provider-blob branch does, and wrong in the same way if it is skipped.
  const settled = mapping.get(key);

  // A record for a connection the profile no longer declares. It was orphaned
  // under contract 2 already — no row, and `hoistConnections` reads rows — so
  // hoisting it would manufacture a connection that nothing grants and no
  // credential backs, and its key can collide with a rename that is real.
  if (settled === undefined) return null;

  const to = `${layout.state()}/${objectKey(CONNECTIONS_NAMESPACE, settled)}`;

  // Two profiles that connected the same account merge into one row, so both
  // hold a record for it. They describe one connection; the second differs only
  // in when it was last written.
  if (settled === key) return claim(claimed, { from, to });

  const dot = settled.indexOf('.');
  const provider = settled.slice(0, dot);
  const id = settled.slice(dot + 1);
  return claim(claimed, { from, to, rewrite: (data) => retarget(data, provider, id) });
}

/** First claim on a destination wins; a later one is left where it is. */
function claim(claimed: Set<string>, move: Move): Move | null {
  if (claimed.has(move.to)) return null;
  claimed.add(move.to);
  return move;
}

/**
 * A connection record, told what it is now called.
 *
 * Spread rather than assigned field by field so the operator's key order — and
 * anything a later version added that this one does not know about — survives
 * the rewrite.
 *
 * Bytes that are not a JSON object are returned untouched. This is a migration,
 * and refusing to move something because it could not be parsed would strand it
 * under a profile directory nothing reads.
 */
function retarget(data: Uint8Array, provider: string, id: string): Uint8Array {
  let record: unknown;
  try {
    record = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return data;
  }

  if (record === null || typeof record !== 'object' || Array.isArray(record)) return data;

  return new TextEncoder().encode(
    JSON.stringify({ ...(record as Record<string, unknown>), provider, id }),
  );
}

/**
 * Copy, verify, then delete. In that order, per object.
 *
 * A move that deleted first would lose an object on any failure, and these are
 * the owner's notes, tasks and entities.
 *
 * A destination that already holds *different* bytes is a bug rather than a case
 * to handle, now that the hoist gives every profile's owner layer its own
 * instance: two sets of notes can no longer be aimed at one key. It used to be
 * skipped silently, which is how work's vault came to be orphaned while `moved`
 * reported it as moved. `assertOneObjectPerDestination` refuses that while this
 * is still a plan, and the check here catches what a plan cannot see.
 *
 * **The same bytes at the destination is the interrupted move, and it finishes
 * it.** Copy-then-delete has a window between the two, and this migration now
 * runs against buckets — where the window is a network round trip rather than a
 * syscall, and an interruption is something that happens rather than something
 * to reason about. Refusing there would have meant a workspace that could not be
 * migrated by running the migration again, which is the one recovery this file
 * promises.
 */
/** Which instance of a single-instance surface this profile's store became. */
function instanceOf(mapping: ReadonlyMap<string, string>, provider: string): string {
  for (const [from, to] of mapping) {
    if (from.startsWith(`${provider}.`)) return to.split('.')[1] ?? 'main';
  }
  return 'main';
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
      if (!sameBytes(held, data)) {
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

