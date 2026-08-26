import type { Config } from '#profile';

/**
 * What differs between a workspace and a target's copy of it.
 *
 * A deployed endpoint reads its config out of a bucket, and `deploy` puts it
 * there — so from the moment of the first deploy there are two copies of every
 * profile. They are supposed to agree. When they do not, one of them holds
 * something the other has lost, and until now nothing could say which or bring
 * it back.
 *
 * This file only *finds* the difference. Deciding it and writing it are
 * `sync-apply.ts`, and choosing which bucket to compare against is the command.
 * Split that way because the diff is the part worth testing exhaustively and
 * the only part with no I/O in it.
 */

/** Which side is missing what, or that both have it and disagree. */
export type Direction = 'pull' | 'push' | 'conflict';

export interface Change {
  /** Where in the config, e.g. `['targets', 'cloud']` or `['connections']`. */
  readonly path: readonly string[];
  readonly direction: Direction;
  /** What remote holds. Absent when remote is the side that is missing it. */
  readonly remote?: unknown;
  /** What local holds. Absent when local is the side that is missing it. */
  readonly local?: unknown;
}

/**
 * Arrays whose elements are records rather than an ordered list.
 *
 * `connections` is a set of accounts keyed by `provider.id`; comparing it
 * positionally would call a reordered file a conflict and, worse, would call an
 * *added* connection a change to whichever one now sits at that index. The key
 * function is what makes "personal gained a mailbox" a different fact from
 * "personal's third connection changed".
 *
 * `identity` is deliberately absent. Its declaration order is meaningful — the
 * first entry of a kind is the one to reach for — so it is an ordered list and
 * compares as one.
 */
const KEYED: Record<string, (item: unknown) => string | undefined> = {
  connections: (item) =>
    isRecord(item) ? `${String(item['provider'])}.${String(item['id'])}` : undefined,
  // Two shapes, and both are reached. The diff runs over validated configs,
  // where `allow: [gmail.*]` has become `[{capability: gmail.*}]`; the writer
  // runs over the raw document, where it is still a string. A key function that
  // knew only the validated shape found nothing to merge and silently wrote the
  // array without it.
  'policy.allow': capabilityOf,
  'policy.deny': capabilityOf,
};

function capabilityOf(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  return isRecord(item) ? String(item['capability']) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every difference between one profile's two copies.
 *
 * Recursive over objects so a change reports at the narrowest path that
 * describes it: two profiles differing only in `auth.authorization` produce
 * that path, not `auth`, and applying it cannot take `token_ref` with it.
 */
export function diffConfigs(local: Config | undefined, remote: Config | undefined): Change[] {
  if (local === undefined && remote === undefined) return [];

  // A whole profile that only one side has. Reported at the root, because the
  // unit that has to be copied is the file.
  if (local === undefined) return [{ path: [], direction: 'pull', remote }];
  if (remote === undefined) return [{ path: [], direction: 'push', local }];

  return walk([], local as unknown, remote as unknown);
}

function walk(path: readonly string[], local: unknown, remote: unknown): Change[] {
  if (same(local, remote)) return [];

  if (local === undefined) return [{ path, direction: 'pull', remote }];
  if (remote === undefined) return [{ path, direction: 'push', local }];

  const key = path.join('.');
  const keyOf = KEYED[key];
  if (keyOf && Array.isArray(local) && Array.isArray(remote)) {
    return walkKeyed(path, keyOf, local, remote);
  }

  if (isRecord(local) && isRecord(remote)) {
    const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
    return keys.flatMap((name) => walk([...path, name], local[name], remote[name]));
  }

  // Two scalars, or two ordered arrays, that are not equal. There is no
  // narrower path to report and no way to have both.
  return [{ path, direction: 'conflict', local, remote }];
}

/**
 * A keyed array, compared as the set of records it is.
 *
 * Each element reports under `path.key` — `connections.gmail.work` — so a
 * missing account names itself in the output instead of appearing as an index.
 * Applying still rewrites the whole array, because a YAML sequence has no
 * addressable slot for "the element whose provider is gmail".
 */
function walkKeyed(
  path: readonly string[],
  keyOf: (item: unknown) => string | undefined,
  local: readonly unknown[],
  remote: readonly unknown[],
): Change[] {
  const index = (items: readonly unknown[]): Map<string, unknown> =>
    new Map(
      items
        .map((item) => [keyOf(item), item] as const)
        .filter((pair): pair is readonly [string, unknown] => pair[0] !== undefined),
    );

  const here = index(local);
  const there = index(remote);
  const names = [...new Set([...here.keys(), ...there.keys()])].sort();

  return names.flatMap((name) => walk([...path, name], here.get(name), there.get(name)));
}

/**
 * The array a change belongs to, when it belongs to one.
 *
 * `['connections', 'gmail.work']` is applied by rewriting `connections`, so
 * both the writer and the renderer need to know where the element stops and the
 * key begins. Longest prefix first, so `policy.allow` wins over `policy`.
 */
export function keyedArrayFor(path: readonly string[]): readonly string[] | undefined {
  for (let depth = path.length - 1; depth > 0; depth--) {
    if (path.slice(0, depth).join('.') in KEYED) return path.slice(0, depth);
  }
  return undefined;
}

/**
 * How an element of a keyed array identifies itself, for the writer.
 *
 * The diff indexes these to compare them; applying one has to find the same
 * element again in *both* raw documents, and it cannot re-derive the key from
 * the path — `connections.gmail.work` is one key containing a dot, not two
 * steps. Exported so the two halves cannot disagree about what identifies a
 * connection.
 */
export function keyOfElement(arrayPath: readonly string[], item: unknown): string | undefined {
  return KEYED[arrayPath.join('.')]?.(item);
}

/** Whether a set of changes can be applied without being told which side wins. */
export function conflictsIn(changes: readonly Change[]): Change[] {
  return changes.filter((change) => change.direction === 'conflict');
}
