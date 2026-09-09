import type { MergedCapability } from './visibility.ts';

/**
 * What this caller can reach, said once at the top of every answer.
 *
 * A search answers "which capability", and a call needs three things: the
 * capability, the profile, and the connection. The first two words of every
 * tool's schema say `profile` and `connection` are required, and until now the
 * only place to find out what they may be was a second round trip to
 * `lanes_setup_overview` — or the per-result `reachable:` line, which names the
 * connections of the results that came back and says nothing about the ones
 * that did not.
 *
 * So the routing is stated up front rather than inferred from the results. It
 * costs a few hundred bytes on every search and saves a call on most of them,
 * and it is the difference between a model that composes the next call and one
 * that asks the endpoint what it is allowed to ask for.
 *
 * **Derived from the merged set, never from the config.** The merged set is
 * already filtered to what this principal may reach, per profile — so a box
 * built from it cannot name a profile the caller is not a member of or a
 * connection policy withheld. Reading the workspace's connection list instead
 * would be the discovery leak `mergeCapabilities` exists to prevent: default
 * deny is not weakened by a helpful summary that mentions what was denied
 * (ADR-060).
 */

/** One profile, and the accounts reachable through it. */
export interface Reach {
  readonly profile: string;
  readonly connections: string[];
}

/**
 * Every profile and connection that appears anywhere in the merged set.
 *
 * The union across capabilities rather than a lookup, because "reachable" is a
 * property of a capability in a profile and a connection is only reachable if
 * something can be done with it. A connection granted no capability is not a
 * routing option, and listing it would offer the caller a `connection` value
 * every call with it would refuse.
 */
export function reachOf(merged: ReadonlyMap<string, MergedCapability>): Reach[] {
  const byProfile = new Map<string, Set<string>>();

  for (const entry of merged.values()) {
    for (const [profile, connections] of entry.reachable) {
      const known = byProfile.get(profile) ?? new Set<string>();
      for (const connection of connections) known.add(connection);
      byProfile.set(profile, known);
    }
  }

  return [...byProfile]
    .map(([profile, connections]) => ({ profile, connections: [...connections].sort() }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
}

/**
 * The box, as the lines that go above the results.
 *
 * Accounts are named where the endpoint knows them, because `postbox.acct1` and
 * `postbox.acct2` are not a choice anybody can make and "work" and "personal"
 * are. Where it does not — a registry built to read manifests has no selection
 * — the bare ref is still the value the call takes, so the box is useful either
 * way.
 *
 * One line per profile, and the connections on it. A row per connection reads
 * better and costs four times as much, and this is printed on every search.
 */
export function contextBox(
  reach: readonly Reach[],
  accounts: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string[] {
  if (reach.length === 0) return [];

  const total = reach.reduce((count, row) => count + row.connections.length, 0);
  const width = Math.max(...reach.map((row) => row.profile.length));

  const lines = [
    `Reachable here: ${reach.length} profile${reach.length === 1 ? '' : 's'}, ` +
      `${total} connection${total === 1 ? '' : 's'}. Every call names one of each.`,
    '',
  ];

  for (const { profile, connections } of reach) {
    const known = accounts.get(profile);
    const named = connections.map((ref) => {
      const account = known?.get(ref);
      return account === undefined ? ref : `${ref} (${account})`;
    });
    lines.push(`  ${profile.padEnd(width)}  ${named.join('  ·  ')}`);
  }
  lines.push('');

  return lines;
}
