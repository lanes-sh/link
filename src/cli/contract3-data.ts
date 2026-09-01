import { ConfigError, DATA_DIR, layout } from '#profile';
import { createFileSecretStore } from '#secrets';
import type { BlobStore } from '#stores/blobs';

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
}

/** `gmail.main` — how a connection is addressed in every file after this. */
function keyOf(connection: { provider: string; id: string }): string {
  return `${connection.provider}.${connection.id}`;
}

/**
 * Which credential refs the merged store will hold.
 *
 * Read-only, and it runs before anything is written so the report an operator
 * confirms is the real one. A ref present in two profiles' stores with two
 * different values is the one thing this cannot resolve, and it is reported
 * rather than merged: both are real credentials, and picking either would point
 * a connection at the wrong account's token.
 */
export async function planCredentials(root: string, profiles: readonly string[]): Promise<string[]> {
  const refs = new Set<string>();

  for (const profile of profiles) {
    const store = createFileSecretStore({ path: `${root}/${DATA_DIR}/${profile}/credentials.enc` });
    try {
      for (const ref of await store.list()) refs.add(ref);
    } catch {
      // A store that will not open is reported by `doctor`, not here. This is a
      // preview and must not fail on a workspace that is already broken.
    }
  }

  return [...refs].sort();
}

/**
 * Copy every profile's credentials into the workspace store.
 *
 * Written and read back before the old stores are touched, which is the whole
 * of the safety argument: a half-finished merge that has not deleted anything is
 * recoverable by running it again, and one that deleted first is not.
 *
 * The old stores are left in place regardless. They are a few kilobytes, they
 * are the only copy of anything if this went wrong, and `doctor` names them so
 * an operator can remove them once the endpoint has served a request.
 */
export async function mergeCredentials(root: string, profiles: readonly string[]): Promise<void> {
  const destination = createFileSecretStore({ path: `${root}/${layout.credentials()}` });

  for (const profile of profiles) {
    const source = createFileSecretStore({ path: `${root}/${DATA_DIR}/${profile}/credentials.enc` });

    let refs: string[];
    try {
      refs = await source.list();
    } catch {
      continue;
    }

    for (const ref of refs) {
      const value = await source.get(ref);
      if (value === null) continue;

      const held = await destination.get(ref);
      if (held !== null) {
        if (held === value) continue;
        throw new ConfigError(
          `Two profiles hold different values for the credential "${ref}", and this migration ` +
            `cannot choose between them.\n` +
            `  Both are real credentials for different accounts, and picking either would point a ` +
            `connection at the wrong one.\n` +
            `  Rename one connection before migrating, so its credential ref differs.`,
        );
      }

      await destination.set(ref, value);
      if ((await destination.get(ref)) !== value) {
        throw new ConfigError(
          `The credential "${ref}" did not read back after being written to ` +
            `${layout.credentials()}. Nothing has been deleted; fix the store and run this again.`,
        );
      }
    }
  }
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

  for (const profile of profiles) {
    const mapping = perProfile.get(profile) ?? new Map<string, string>();
    const prefix = `${DATA_DIR}/${profile}/`;

    for (const blob of await files.list(prefix)) {
      const rest = blob.key.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      if (head === undefined) continue;

      // The credential store is merged rather than moved, and the old copy is
      // deliberately left behind. `state.kv` and `audit.log` are per profile and
      // become the workspace's, but their contents already carry the profile in
      // every record, so they are concatenated by moving the objects across.
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
      if (head === 'state.kv' || head === 'audit.log') {
        moves.push({ from: blob.key, to: `${DATA_DIR}/${head}/${tail.join('/')}` });
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

  return moves;
}

/**
 * Copy, verify, then delete. In that order, per object.
 *
 * A move that deleted first would lose an object on any failure, and these are
 * the owner's notes, tasks and entities.
 *
 * A destination that already holds something is a bug rather than a case to
 * handle, now that the hoist gives every profile's owner layer its own instance:
 * two sets of notes can no longer be aimed at one key. It used to be skipped
 * silently, which is how work's vault came to be orphaned while `moved` reported
 * it as moved. It refuses instead, before deleting anything.
 */
/** Which instance of a single-instance surface this profile's store became. */
function instanceOf(mapping: ReadonlyMap<string, string>, provider: string): string {
  for (const [from, to] of mapping) {
    if (from.startsWith(`${provider}.`)) return to.split('.')[1] ?? 'main';
  }
  return 'main';
}

export async function applyMoves(files: BlobStore, moves: readonly Move[]): Promise<void> {
  for (const move of moves) {
    if (move.from === move.to) continue;

    const data = await files.get(move.from);
    if (data === null) continue;

    if (await files.has(move.to)) {
      throw new ConfigError(
        `Two objects want to be at ${move.to}, and this migration cannot merge them.\n` +
          `  ${move.from} is the second. Nothing has been deleted.\n` +
          '  This should be unreachable: the hoist gives every profile its own instance of ' +
          'each owner-layer surface. Please report it with the layout of your data directory.',
      );
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
}

