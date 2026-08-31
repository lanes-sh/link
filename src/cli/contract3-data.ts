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
 * Computed from the hoisted rows rather than from what is on disk, so a blob
 * belonging to a connection that was renamed follows the rename. Anything that
 * matches no rule is left exactly where it is: this moves what it understands
 * and never deletes what it does not.
 */
export async function planMoves(
  files: BlobStore,
  profiles: readonly string[],
  rows: readonly { id: string; provider: string }[],
): Promise<Move[]> {
  const moves: Move[] = [];
  const byOldKey = new Map(rows.map((row) => [keyOf(row), row]));

  for (const profile of profiles) {
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

      if (head === 'vault.enc') {
        moves.push({ from: blob.key, to: layout.vault('main') });
        continue;
      }
      if (head === 'vault.enc.key') {
        moves.push({ from: blob.key, to: `${layout.vault('main')}.key` });
        continue;
      }
      if (head === 'skills.d') {
        moves.push({ from: blob.key, to: `${layout.skills('main')}/${tail.join('/')}` });
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

      const renamed = byOldKey.get(`${head}.${connection}`);
      const id = renamed ? renamed.id : connection;
      moves.push({ from: blob.key, to: `${DATA_DIR}/${head}/${id}/${tail.slice(1).join('/')}` });
    }
  }

  return moves;
}

/**
 * Copy, verify, then delete. In that order, per object.
 *
 * A move that deleted first would lose an object on any failure, and these are
 * the owner's notes, tasks and entities. Copying into a key that already holds
 * something is skipped rather than overwritten: two profiles that both had
 * `memory.main` are two sets of notes, and the second one keeps its own home
 * under a suffixed connection rather than being interleaved with the first.
 */
export async function applyMoves(files: BlobStore, moves: readonly Move[]): Promise<void> {
  for (const move of moves) {
    if (move.from === move.to) continue;

    const data = await files.get(move.from);
    if (data === null) continue;
    if (await files.has(move.to)) continue;

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

