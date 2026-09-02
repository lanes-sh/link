import { layout } from '#profile';
import type { BlobStore } from '#stores/blobs';
import {
  decodeSegment,
  DISCOVERY_NAMESPACE,
  encodeSegment,
  isWorkspaceNamespace,
  OAUTH_NAMESPACE,
} from '#stores/state';
import { C3 } from './contract3-layout.ts';
import { planRenames, renamedProvider } from './contract4-rename.ts';
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

/** Old `<provider>.<id>` to new, for every connection this workspace holds. */
export type Renames = ReadonlyMap<string, string>;

/**
 * The new id for every connection, allocated in file order.
 *
 * File order rather than anything derived, so a rerun produces the same map and
 * a preview matches the apply. A row that already carries an allocated id keeps
 * it — this migration is not a renumbering, and running it twice must not walk
 * `con1` to `con2`.
 *
 * The reserved ids are the owner layer's, and they are what the `lan` prefix is
 * for: a reader can tell a surface built into Lanes from somebody's account
 * without resolving anything.
 */

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
  /**
   * Per-profile credential stores contract 3 merged but did not delete.
   *
   * Named separately because they are a decryptable credential document and its
   * key, and "no profile grants it" is the wrong sentence about one.
   */
  readonly leftover: readonly string[];
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
  renames: Renames = new Map(),
): Promise<DataPlan> {
  /** The id a connection ends up with — itself, where nothing renamed it. */
  const renamed = (provider: string, id: string): string => {
    const to = renames.get(`${provider}.${id}`);
    return to === undefined ? id : to.slice(to.indexOf('.') + 1);
  };

  const moves: Move[] = [];
  const shared: { key: string; profiles: readonly string[] }[] = [];
  const orphaned: string[] = [];
  const leftover: string[] = [];
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
      for (const move of stateMoves(blob.key, tail, granting, claimed, renames, orphaned)) {
        moves.push(move);
      }
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

      const to = renamed(provider, id);
      const into = (profile: string): string =>
        provider === 'vault'
          ? `${layout.vaultRoot(profile)}/${connection.replace(id, to)}`
          : `${layout.skills(profile, to)}/${tail.slice(1).join('/')}`;

      record(blob.key, owners, into, moves, shared, orphaned);
      continue;
    }

    // **A contract-2 leftover is a credential, not an ungranted store.** The
    // contract-3 migration deliberately leaves `data/<profile>/credentials.enc`
    // and its `.key` behind — read back and merged, never deleted — so a
    // workspace that came through it still holds them. Classified as
    // `<provider>/<connection>` they were reported as "no profile grants it, so
    // it stays where it is", which is true and is the wrong sentence about a
    // decryptable credential document: the operator reads it as tidy-up and
    // leaves it.
    if (tail[0] === 'credentials.enc' || tail[0] === 'credentials.enc.key') {
      leftover.push(blob.key);
      continue;
    }

    // Otherwise `<provider>/<connection>/…`, the namespace every provider's
    // blobs are scoped into — memory, tasks, assets, entities and every vendor.
    const connection = tail[0];
    if (connection === undefined) continue;

    const ref = `${head}.${connection}`;
    const owners = granting.get(ref) ?? [];

    // Both segments, from the one rename: a path that took one without the
    // other is a namespace nothing reads.
    const settled = renames.get(ref) ?? ref;
    const dot = settled.indexOf('.');
    const into = `${settled.slice(0, dot)}/${settled.slice(dot + 1)}`;

    record(
      blob.key,
      owners,
      (profile) => `${layout.blobs(profile)}/${into}/${tail.slice(1).join('/')}`,
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

  return { moves, shared, orphaned, leftover };
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
/**
 * The namespaces contract 3 spelled without a dot, and contract 4 does.
 *
 * `discovery` and `oauth/…` were reachable by a provider — only `custom` is
 * refused by grammar, so a manifest with id `oauth` landed inside them — and a
 * dotted name is one no provider can reach. Renaming them is only half the job:
 * the objects already written under the old spelling have to come across, or
 * every client that had signed in is signed out and every discovered spec is
 * fetched again. The rehearsal that found this left 75 OAuth records behind.
 */
const RENAMED_NAMESPACES: readonly [string, string][] = [
  ['discovery', DISCOVERY_NAMESPACE],
  ['oauth', OAUTH_NAMESPACE],
];

/** `<provider>/<connection>` as a state namespace is `<provider>.<connection>` as a ref. */
function refOf(namespace: string): string {
  const slash = namespace.indexOf('/');
  return slash === -1 ? namespace : `${namespace.slice(0, slash)}.${namespace.slice(slash + 1)}`;
}

function stateMoves(
  from: string,
  tail: readonly string[],
  granting: Granting,
  claimed: Set<string>,
  renames: Renames = new Map(),
  orphaned: string[] = [],
): Move[] {
  const leaf = tail[tail.length - 1];

  // **Guarded, the way `contract3-data.ts` guards it and for its reason.**
  // `decodeSegment` is `decodeURIComponent`, which throws `URIError` on a stray
  // `%` — and contract 3's catch moves such a key *verbatim*, so the class of
  // key that survives contract 3 by design is exactly the class this reads. One
  // of them threw `URI malformed`, naming no file, out of `doctor`,
  // `doctor --fix`, `deploy` and `update` alike — including the read-only
  // preview, because `planMoves` runs before the `apply` check.
  //
  // A key this cannot parse is carried across unchanged rather than dropped:
  // whatever wrote it can still find it, and nothing here understands it well
  // enough to place it.
  if (leaf === undefined || tail.length < 2 || !leaf.endsWith('.json')) {
    const move = claim(claimed, { from, to: `${layout.state()}/${tail.join('/')}` });
    return move === null ? [] : [move];
  }

  let namespace: string;
  let key: string;
  try {
    namespace = tail.slice(0, -1).map(decodeSegment).join('/');
    key = decodeSegment(leaf.replace(/\.json$/, ''));
  } catch {
    const move = claim(claimed, { from, to: `${layout.state()}/${tail.join('/')}` });
    return move === null ? [] : [move];
  }

  // The undotted spellings, carried across before anything else looks at them.
  for (const [was, now] of RENAMED_NAMESPACES) {
    if (namespace !== was && !namespace.startsWith(`${was}/`)) continue;

    // Only the first segment. `oauth/tokens` is two segments and each is
    // encoded on its own, so encoding `oauth.v1/tokens` whole would escape the
    // separator too and write one segment named `oauth%2Ev1%2Ftokens`.
    const move = claim(claimed, {
      from,
      to: `${layout.state()}/${[encodeSegment(now), ...tail.slice(1)].join('/')}`,
    });
    return move === null ? [] : [move];
  }

  if (isWorkspaceNamespace(namespace)) {
    // A connection record is keyed on the ref *and* carries it in the body:
    // `ConnectionRepository.list` reads `provider` and `id` out of the record,
    // not out of the key. A renamed connection whose bytes moved verbatim would
    // sit at `connections.v1/gmail.con1` still calling itself `gmail.main`, and
    // the next reconcile would write a second record beside it.
    const settled = namespace === 'connections.v1' ? renames.get(key) : undefined;
    const to = `${layout.state()}/${
      settled === undefined ? tail.join('/') : `${tail[0]!}/${encodeSegment(settled)}.json`
    }`;

    // Two profiles both hold a record for a connection they share, and the
    // second differs only in when it was written.
    const move = claim(claimed, {
      from,
      to,
      ...(settled === undefined
        ? {}
        : { rewrite: (data: Uint8Array) => retarget(data, settled) }),
    });
    return move === null ? [] : [move];
  }

  // A cursor's namespace is `cursors.v1` and its *key* is the connection; a
  // provider's own store is namespaced `<provider>/<connection>` instead — and
  // that slash is not the dot a grant is keyed on. Looking the one up with the
  // other matched nothing and dropped every provider's state in silence, which
  // is the same shape of bug `contract3-data.ts` records having shipped once.
  const cursor = namespace === 'cursors.v1';
  const ref = cursor ? key : refOf(namespace);
  const owners = granting.get(ref) ?? [];

  if (owners.length === 0) {
    orphaned.push(from);
    return [];
  }

  const settled = renames.get(ref) ?? ref;
  const dot = settled.indexOf('.');

  // The rename reaches whichever half carries the ref, and only that half.
  const moved = cursor
    ? `${tail[0]!}/${encodeSegment(settled)}.json`
    : [
        encodeSegment(settled.slice(0, dot)),
        encodeSegment(settled.slice(dot + 1)),
        ...tail.slice(2),
      ].join('/');

  return owners.map((profile) => ({
    from,
    to: `${layout.profileState(profile)}/${moved}`,
    keep: owners.length > 1,
  }));
}

/**
 * A connection record, told what it is now called.
 *
 * Spread rather than assigned field by field, so key order and anything a later
 * version added survive. Bytes that are not a JSON object come back untouched:
 * refusing to move what will not parse strands it where nothing reads it.
 */
function retarget(data: Uint8Array, ref: string): Uint8Array {
  try {
    const held = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    if (held === null || typeof held !== 'object' || Array.isArray(held)) return data;

    const dot = ref.indexOf('.');
    return new TextEncoder().encode(
      JSON.stringify({ ...held, provider: ref.slice(0, dot), id: ref.slice(dot + 1) }),
    );
  } catch {
    return data;
  }
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
