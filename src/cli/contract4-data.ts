import { layout } from '#profile';
import type { BlobStore } from '#stores/blobs';
import { decodeSegment, isWorkspaceNamespace } from '#stores/state';
import { C3 } from './contract3-layout.ts';
import { claim, type Move } from './migrate-move.ts';

/**
 * The half of the contract-4 migration that moves bytes rather than YAML.
 *
 * Contract 3 hoisted everything a profile owned up to the workspace; this
 * carries it back down (ADR-066), and flattens what stays at the workspace out
 * of `data/` while it is here (ADR-067). Same seam as `contract3-data.ts`, and
 * the same ordering rule: everything that can refuse happens while this is
 * still a plan.
 *
 * **The interesting decision is what to do with a store two profiles grant.**
 * Contract 3's default gives every profile a grant on the same `.main`
 * instances, so the common case in a freshly created workspace is that both
 * profiles point at one memory. There is no answer that is right for everyone:
 * moving it into one profile takes it away from the other, and merging is not a
 * thing bytes can do. So it is **copied into each, and the original is left**.
 * The operator is told, and deletes what they do not want — which is the only
 * step in this migration that is theirs rather than ours.
 */

/** Which profiles grant a connection, by `<provider>.<id>`. */
export type Granting = ReadonlyMap<string, readonly string[]>;

export interface DataPlan {
  readonly moves: readonly Move[];
  /**
   * What was copied rather than moved, and into which profiles.
   *
   * Reported so the operator can delete the original. Never deleted here: a
   * store two profiles were sharing is one whose owner has to decide, and this
   * migration guessing would be the silent wrong answer ADR-059 warns about for
   * the vault in particular.
   */
  readonly shared: readonly { readonly key: string; readonly profiles: readonly string[] }[];
  /** Granted by nobody. Left exactly where it is, and named. */
  readonly orphaned: readonly string[];
}

/**
 * Where every object under `data/` is going.
 *
 * Anything matching no rule is left where it is — this moves what it
 * understands and never deletes what it does not.
 */
export async function planMoves(
  files: BlobStore,
  granting: Granting,
  profiles: readonly string[],
): Promise<DataPlan> {
  const moves: Move[] = [];
  const shared: { key: string; profiles: readonly string[] }[] = [];
  const orphaned: string[] = [];
  const claimed = new Set<string>();

  for (const blob of await files.list('data/')) {
    const parts = blob.key.split('/').slice(1);
    const head = parts[0];
    const tail = parts.slice(1);
    if (head === undefined) continue;

    // The four the workspace keeps, out of `data/` and up to the root.
    if (head === 'credentials.enc' || head === 'credentials.enc.key') {
      moves.push({ from: blob.key, to: head });
      continue;
    }
    if (head === 'providers.d') {
      moves.push({ from: blob.key, to: `${layout.providers()}/${tail.join('/')}` });
      continue;
    }
    if (head === 'audit.log') {
      moves.push({ from: blob.key, to: `${layout.audit()}/${tail.join('/')}` });
      continue;
    }
    if (head === 'state.kv') {
      for (const move of stateMoves(blob.key, tail, granting, claimed)) moves.push(move);
      continue;
    }

    // `vault.d/<id>.enc` and `skills.d/<id>/...` — the two the profile takes
    // back, keyed by the connection that already owns them.
    if (head === 'vault.d' || head === 'skills.d') {
      const connection = tail[0];
      if (connection === undefined) continue;

      const provider = head === 'vault.d' ? 'vault' : 'skills';
      // A vault document is `<id>.enc`, so the id has the suffix stripped; a
      // skills directory is the id itself.
      const id = provider === 'vault' ? connection.replace(/\.enc(\.key)?$/, '') : connection;
      const owners = granting.get(`${provider}.${id}`) ?? [];

      const into = (profile: string): string =>
        provider === 'vault'
          ? `${layout.vaultRoot(profile)}/${connection}`
          : `${layout.skills(profile, id)}/${tail.slice(1).join('/')}`;

      record(blob.key, owners, into, moves, shared, orphaned);
      continue;
    }

    // Otherwise `<provider>/<connection>/…`, the namespace every provider's
    // blobs are scoped into — memory, tasks, assets, entities and every vendor.
    const connection = tail[0];
    if (connection === undefined) continue;

    const owners = granting.get(`${head}.${connection}`) ?? [];
    record(
      blob.key,
      owners,
      (profile) => `${layout.blobs(profile)}/${head}/${connection}/${tail.slice(1).join('/')}`,
      moves,
      shared,
      orphaned,
    );
  }

  // The declarations themselves, into the directory each now owns.
  for (const profile of profiles) {
    const from = C3.profile(profile);
    if (await files.has(from)) moves.push({ from, to: layout.profileConfig(profile) });
  }

  return { moves, shared, orphaned };
}

/**
 * One object, routed by how many profiles grant the connection it belongs to.
 *
 * Exactly one is a move. Several is a copy into each, with the original left
 * behind — see the header. None is left alone and named: a store nothing grants
 * is not this migration's to place, and deleting it would be the one
 * irreversible thing in here.
 */
function record(
  key: string,
  owners: readonly string[],
  into: (profile: string) => string,
  moves: Move[],
  shared: { key: string; profiles: readonly string[] }[],
  orphaned: string[],
): void {
  if (owners.length === 0) {
    orphaned.push(key);
    return;
  }

  if (owners.length === 1) {
    moves.push({ from: key, to: into(owners[0]!) });
    return;
  }

  // `keep` rather than a move: `applyMoves` deletes the source once the copy
  // reads back, and there is a second destination still to write.
  for (const profile of owners) moves.push({ from: key, to: into(profile), keep: true });
  shared.push({ key, profiles: owners });
}

/**
 * Where one object under `data/state.kv` goes — and it may go to two places.
 *
 * The split is by namespace rather than by key: connection records, the
 * discovery cache and the endpoint's own OAuth server are the workspace's, and
 * everything else is one profile's use of an account. `isWorkspaceNamespace` in
 * `#stores/state` is that rule and this reads it rather than restating it.
 *
 * A cursor belongs to whichever profiles grant its connection, so it takes the
 * same fan-out as a blob does. The alternative — one cursor shared — is exactly
 * the bug ADR-066 is fixing, two agents consuming each other's position.
 */
function stateMoves(
  from: string,
  tail: readonly string[],
  granting: Granting,
  claimed: Set<string>,
): Move[] {
  const namespace = tail.slice(0, -1).map(decodeSegment).join('/');
  const leaf = tail[tail.length - 1];
  if (leaf === undefined) return [];

  if (isWorkspaceNamespace(namespace)) {
    // Two profiles both hold a record for a connection they share, and the
    // second differs only in when it was written.
    const move = claim(claimed, { from, to: `${layout.state()}/${tail.join('/')}` });
    return move === null ? [] : [move];
  }

  const key = decodeSegment(leaf.replace(/\.json$/, ''));
  // A cursor's namespace is `cursors.v1` and its *key* is the connection;
  // a provider's own store is namespaced `<provider>/<connection>` instead.
  const ref = namespace === 'cursors.v1' ? key : namespace;
  const owners = granting.get(ref) ?? [];

  return owners.map((profile) => ({
    from,
    to: `${layout.profileState(profile)}/${tail.join('/')}`,
    keep: owners.length > 1,
  }));
}

/**
 * Which profiles grant each connection, read off the profiles themselves.
 *
 * Derived rather than assumed, because the fan-out above is the whole decision:
 * a connection nobody grants must not be placed anywhere, and one two profiles
 * grant must not be placed in only the first. `connections.yaml` cannot answer
 * this — it says what exists, not who selected it (ADR-057).
 */
export function grantingProfiles(
  configs: ReadonlyMap<string, { grants?: { connection?: unknown }[] }>,
): Granting {
  const granting = new Map<string, string[]>();

  for (const [profile, config] of configs) {
    for (const grant of config.grants ?? []) {
      const ref = grant.connection;
      if (typeof ref !== 'string') continue;
      const owners = granting.get(ref) ?? [];
      if (!owners.includes(profile)) owners.push(profile);
      granting.set(ref, owners);
    }
  }

  return granting;
}
