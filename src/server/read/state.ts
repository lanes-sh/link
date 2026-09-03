import { allowedConnections } from '#policy';
import { defaultConnectionLabel } from '#profile';
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
  /**
   * What a reader should be shown: the operator's own word for it, or the name
   * derived from the provider and the account when they never gave one.
   *
   * `gmail.ada_lovelace` is an address, not a name. A dashboard listing refs is
   * asking somebody to read identifiers when they gave the thing a label
   * precisely so they would not have to.
   *
   * **Filled rather than left null**, which reverses what this said. Null meant
   * "they never gave one" and every consumer answered it the same way, by
   * showing the id — so a dashboard's whole Label column read `con8`, `lan7`,
   * `con5`. `connect` writes no label that only repeats the lines above it
   * (`declareConnection`), so an unlabelled row is the ordinary case and not an
   * omission worth reporting. `null` survives for the row nothing can name: a
   * grant pointing at a connection the workspace no longer holds.
   */
  readonly label: string | null;
  /** The identity the provider reported at connect time. */
  readonly account: string | null;
  /** Which profiles grant this connection at all. */
  readonly profiles: readonly string[];
}

/**
 * What a provider is called, asked of whoever built the registry.
 *
 * A function rather than a catalogue, because `server` may not import
 * `#providers` — the read surface has no business knowing the vendor list, and
 * the rule that says so is `architecture.test.ts`. Both binds already hold a
 * `Runtime`, whose registry names the owner layer, the catalogue and a
 * workspace's own manifests alike, so the caller passes a closure over that.
 *
 * Defaulted to naming nothing. A caller that supplies none gets `label: null`
 * on an unlabelled row, which is what every reader saw before this existed.
 */
export type ProviderNames = (provider: string) => string | undefined;

/** The connection rows as `connections.yaml` holds them. */
export interface ConnectionRow {
  readonly provider: string;
  readonly id: string;
  readonly account?: string | undefined;
  readonly label?: string | undefined;
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

/**
 * What the endpoint says about itself.
 *
 * Added because the dashboard now reads more than one kind of endpoint and had
 * no way to tell which it was looking at — the page derived "local" from the
 * fact that the only address it could reach was a loopback one, which stopped
 * being true the moment a deployed workspace became readable.
 *
 * `certificateExpiresAt` is loopback's alone. ADR-063 promised that an expiry
 * would be reported and nothing reported it; an expired certificate fails in
 * the browser with an error the page cannot read, so the one place it can
 * usefully appear is inside a response sent while the certificate still works.
 * A deployed endpoint has none of its own — the platform terminates TLS — and
 * says `null` rather than inventing one.
 */
export interface ReadEndpoint {
  readonly kind: 'local' | 'deployed';
  /** The version serving this request, so a page can say what it is reading. */
  readonly version: string;
  readonly certificateExpiresAt: string | null;
}

export interface ReadState {
  readonly workspace: string;
  readonly endpoint: ReadEndpoint;
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
  rows: readonly ConnectionRow[],
  endpoint: ReadEndpoint,
  providerName: ProviderNames = () => undefined,
): ReadState {
  // The workspace's own list is the source of truth for *which connections
  // exist*. Deriving it from the grants instead made an account that no profile
  // grants invisible — and that is precisely the state `connect` leaves one in
  // when it is run without `--profile`, so a freshly authorised account did not
  // appear at all. Grants say who can reach a connection, not whether it is
  // there.
  const grantedBy = new Map<string, string[]>();
  const described: ReadProfile[] = [];

  for (const [name, runtime] of profiles) {
    const grants: ReadGrant[] = [];

    for (const grant of runtime.config.grants) {
      const ref = grant.connection;
      grantedBy.set(ref, [...(grantedBy.get(ref) ?? []), name]);

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

  const connections: ReadConnection[] = rows.map((row) => {
    const ref = `${row.provider}.${row.id}`;
    const named = providerName(row.provider);
    return {
      ref,
      provider: row.provider,
      id: row.id,
      // The same rule `connect` offers and `connection list` prints, so one
      // connection is called one thing wherever somebody reads it.
      label: row.label ?? (named ? defaultConnectionLabel(named, row.account) : null),
      account: row.account ?? null,
      profiles: grantedBy.get(ref) ?? [],
    };
  });

  // A grant naming a connection the workspace no longer holds. `assertGrantsResolve`
  // refuses this at load, so it is unreachable through the CLI — but the read
  // surface should describe what is there rather than assume, and a row that
  // appeared only in a grant would otherwise vanish from the listing while
  // still governing a profile.
  const known = new Set(connections.map((one) => one.ref));
  for (const ref of grantedBy.keys()) {
    if (known.has(ref)) continue;
    const [provider = ref, id = ''] = ref.split('.');
    connections.push({
      ref,
      provider,
      id,
      label: null,
      account: null,
      profiles: grantedBy.get(ref) ?? [],
    });
  }

  return { workspace, endpoint, connections, profiles: described };
}
