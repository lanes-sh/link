import { allowedConnections } from '#policy';
import type { ProfileRuntime } from '../mcp/visibility.ts';

/**
 * What the dashboard is shown, assembled.
 *
 * Read-only by construction rather than by convention: this produces plain data
 * and holds nothing that can mutate. Every field is something the CLI already
 * prints — `status`, `connection list` and `profile show` in one document — so
 * nothing here is readable that a person at this machine could not already read.
 *
 * **No credential is in it.** Not a connection's tokens, not a vault value, not
 * the contents of a secret ref. What is here is the shape of the workspace:
 * which accounts exist, which profiles select them, and what each allows.
 */

export interface ReadConnection {
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
  /** Which profiles grant this connection at all. */
  readonly profiles: readonly string[];
}

export interface ReadGrant {
  readonly connection: string;
  /** The capability ids reachable on it, after the floor and the profile's rules. */
  readonly reachable: readonly string[];
}

export interface ReadProfile {
  readonly name: string;
  readonly description: string | null;
  readonly grants: readonly ReadGrant[];
  /** Subjects only. An email is a fact about a person that is not held here. */
  readonly members: readonly { subject: string; role: string }[];
}

export interface ReadState {
  readonly workspace: string;
  readonly connections: readonly ReadConnection[];
  readonly profiles: readonly ReadProfile[];
}

/**
 * The workspace as the dashboard sees it.
 *
 * `reachable` comes from `allowedConnections`, the same call discovery and
 * enforcement make. That is the point rather than a convenience: a dashboard
 * that decided visibility its own way would eventually disagree with the
 * endpoint about what a profile can do, and the version a person reads would be
 * the wrong one.
 */
export function readState(
  workspace: string,
  profiles: ReadonlyMap<string, ProfileRuntime>,
): ReadState {
  const connections = new Map<string, ReadConnection & { profiles: string[] }>();
  const described: ReadProfile[] = [];

  for (const [name, runtime] of profiles) {
    const grants: ReadGrant[] = [];

    for (const grant of runtime.config.grants) {
      const ref = grant.connection;
      const [provider = ref, id = ''] = ref.split('.');

      const existing = connections.get(ref);
      if (existing) existing.profiles.push(name);
      else connections.set(ref, { ref, provider, id, profiles: [name] });

      const reachable = runtime.registry
        .capabilities()
        .filter(
          ({ id: capability }) =>
            allowedConnections(capability, [ref], name, runtime.policy, runtime.floor).length > 0,
        )
        .map(({ id: capability }) => capability);

      grants.push({ connection: ref, reachable });
    }

    described.push({
      name,
      description: runtime.config.description ?? null,
      grants,
      members: runtime.config.members.map((member) => ({
        subject: member.subject,
        role: member.role,
      })),
    });
  }

  return { workspace, connections: [...connections.values()], profiles: described };
}
