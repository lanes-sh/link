import { ConfigError, LEGACY_DATA_DIR } from '#profile';
import { applyMoves, assertOneObjectPerDestination, claim, type Move } from './migrate-move.ts';
import { C3 } from './contract3-layout.ts';
import type { BlobStore } from '#stores/blobs';
import { CONNECTIONS_NAMESPACE, decodeSegment, objectKey } from '#stores/state';

/**
 * The half of the contract-3 migration that moves bytes rather than YAML.
 *
 * Split from `contract3.ts` on the seam the migration already has: that file
 * decides *what* the new shape is, and this one carries the credentials and
 * objects into it. Both are ordered so a crash between any two steps leaves a
 * workspace that still opens — nothing is deleted until it has been read back.
 */


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
    const prefix = `${LEGACY_DATA_DIR}/${profile}/`;

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
        moves.push({ from: blob.key, to: C3.vault(instanceOf(mapping, 'vault')) });
        continue;
      }
      if (head === 'vault.enc.key') {
        moves.push({ from: blob.key, to: `${C3.vault(instanceOf(mapping, 'vault'))}.key` });
        continue;
      }
      if (head === 'skills.d') {
        moves.push({
          from: blob.key,
          to: `${C3.skills(instanceOf(mapping, 'skills'))}/${tail.join('/')}`,
        });
        continue;
      }
      // Under ADR-030 a manifest lived in the profile, so an operator using
      // their own connector in two profiles holds two copies of one file. They
      // are the same manifest; refusing byte-identical files and asking for the
      // data directory's layout was not a useful answer.
      if (head === 'providers.d') {
        const move = claim(claimed, {
          from: blob.key,
          to: `${C3.providers()}/${tail.join('/')}`,
        });
        if (move !== null) moves.push(move);
        continue;
      }
      // One object per event under a key already carrying the timestamp, so
      // concatenating three profiles' logs is exactly moving them across.
      if (head === 'audit.log') {
        moves.push({ from: blob.key, to: `${C3.audit()}/${tail.join('/')}` });
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
      moves.push({ from: blob.key, to: `${LEGACY_DATA_DIR}/${head}/${id}/${tail.slice(1).join('/')}` });
    }
  }

  assertOneObjectPerDestination(moves);
  return moves;
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
 * Keys are decoded rather than pattern-matched: on disk both halves are
 * percent-encoded per segment (`connections%2Ev1/vault%2Emain.json`), and
 * respelling that here would be a second copy of an encoding that must have one.
 *
 * `null` means leave it where it is — nothing is deleted by not moving it, and
 * `doctor` names what is left.
 */
function stateMove(
  from: string,
  tail: readonly string[],
  mapping: ReadonlyMap<string, string>,
  claimed: Set<string>,
): Move | null {
  const here = `${C3.state()}/${tail.join('/')}`;
  const leaf = tail[tail.length - 1];

  // Not an object this module wrote: moved as it is, and still held to the
  // one-object-per-destination rule, because an unrecognised collision is a
  // thing to refuse rather than to resolve by guessing.
  if (tail.length < 2 || leaf === undefined || !leaf.endsWith('.json')) {
    return { from, to: here };
  }

  // `decodeSegment` is `decodeURIComponent`, which throws `URIError` on a stray
  // `%`. Aborting somebody's whole migration on `URI error`, naming no file, is
  // not an answer — an undecodable key is one this does not understand, and
  // those are moved as they are.
  let segments: string[];
  let key: string;
  try {
    segments = tail.slice(0, -1).map(decodeSegment);
    key = decodeSegment(leaf.slice(0, -'.json'.length));
  } catch {
    return { from, to: here };
  }
  const namespace = segments.join('/');

  // Keyed on the provider id, not a connection, so two profiles on the same
  // vendor hold two entries under one key. `open.ts` treats a miss and a corrupt
  // entry alike as "not discovered yet" and `connect` refreshes it: first wins.
  if (namespace === 'discovery') {
    return claim(claimed, { from, to: here });
  }

  // `<provider>/<connection>` — a provider's own state, keyed on the connection
  // exactly as its blobs are. Left out of the first pass, so two profiles
  // holding one provider's fixed-name object (`dav`'s home, `bunq`'s session)
  // still aimed at one key.
  if (segments.length === 2) {
    const [provider, connection] = segments as [string, string];
    const settled = mapping.get(`${provider}.${connection}`);
    if (settled === undefined) return { from, to: here };

    const id = settled.slice(settled.indexOf('.') + 1);
    return claim(claimed, { from, to: `${C3.state()}/${objectKey(`${provider}/${id}`, key)}` });
  }

  if (namespace !== CONNECTIONS_NAMESPACE) return { from, to: here };

  // This profile's old key, through this profile's mapping — the same lookup
  // the provider-blob branch does, and wrong in the same way if it is skipped.
  const settled = mapping.get(key);

  // Orphaned under contract 2 already — no row, and `hoistConnections` reads
  // rows — so hoisting it would manufacture a connection nothing grants, and its
  // key can collide with a rename that is real.
  if (settled === undefined) return null;

  const to = `${C3.state()}/${objectKey(CONNECTIONS_NAMESPACE, settled)}`;

  // Two profiles on one account merge into one row, so both hold a record for
  // it. One connection; the second differs only in when it was written.
  if (settled === key) return claim(claimed, { from, to });

  const dot = settled.indexOf('.');
  const provider = settled.slice(0, dot);
  const id = settled.slice(dot + 1);
  return claim(claimed, { from, to, rewrite: (data) => retarget(data, provider, id) });
}


/**
 * A connection record, told what it is now called.
 *
 * Spread rather than assigned field by field, so key order and anything a later
 * version added survive. Bytes that are not a JSON object are returned
 * untouched: refusing to move what would not parse strands it under a profile
 * directory nothing reads.
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


