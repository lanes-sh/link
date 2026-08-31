import { ConfigError, describeRename } from './load.ts';
import type { Config, ConnectionConfig, GrantConfig } from './schema.ts';

/**
 * The join between a profile and the workspace it lives in.
 *
 * A connection is declared once, in `connections.yaml`, and a profile names the
 * ones it selects in `grants:` (ADR-057). Nothing downstream should perform
 * that join itself: `dispatch`, `visibility`, `status`, `setup` and the
 * reconciler all want the same answer — *which accounts does this profile
 * reach, and what may be done with each* — and three implementations of one
 * join is three chances for discovery and enforcement to disagree, which is the
 * failure `allowedConnections` exists to prevent on the capability axis.
 *
 * So this file answers it once and everything else asks.
 */

/** `<provider>.<id>` — the same string an agent passes as `connection`. */
export function connectionRefOf(connection: ConnectionConfig): string {
  return `${connection.provider}.${connection.id}`;
}

/**
 * One account this profile reaches, with the rules that govern it.
 *
 * The grant travels with the connection deliberately. Every caller that has a
 * connection in its hand is about to ask what may be done with it, and handing
 * back a pair removes the second lookup — along with the possibility of pairing
 * a connection with the wrong profile's grant, which is the one mistake this
 * shape makes unrepresentable.
 */
export interface SelectedConnection {
  readonly ref: string;
  readonly connection: ConnectionConfig;
  readonly grant: GrantConfig;
}

/**
 * The connections a profile selects, in the order it declares them.
 *
 * Declaration order rather than the workspace's, because the profile is what
 * this is a view of, and a listing that reordered the owner's own file would be
 * answering a question nobody asked. A grant naming a connection that does not
 * exist is skipped here and refused by `assertGrantsResolve` at load — this
 * function is a view, not a gate, and a view that threw would make every
 * listing depend on the config being valid.
 */
export function selectConnections(
  config: Config,
  available: readonly ConnectionConfig[],
): SelectedConnection[] {
  const byRef = new Map(available.map((connection) => [connectionRefOf(connection), connection]));

  return config.grants.flatMap((grant) => {
    const connection = byRef.get(grant.connection);
    return connection === undefined ? [] : [{ ref: grant.connection, connection, grant }];
  });
}

/**
 * Every reference in a profile resolves, and nothing is granted twice.
 *
 * Two failures, and the second is the one worth having a check for. A grant
 * naming a connection the workspace does not hold is visible the moment anyone
 * looks — the surface is simply absent. Two grants naming the *same* connection
 * is not: one of them silently wins, and which one depends on iteration order,
 * so a profile could deny a capability in one row and allow it in another and
 * behave differently between releases. Refusing at load is what keeps
 * `grants:` a set rather than a sequence with precedence.
 */
export function assertGrantsResolve(
  config: Config,
  available: readonly ConnectionConfig[],
): void {
  const refs = new Set(available.map(connectionRefOf));

  const missing = config.grants
    .map((grant) => grant.connection)
    .filter((ref) => !refs.has(ref));

  if (missing.length > 0) {
    throw new ConfigError(
      `Profile "${config.instance.profile}" grants a connection this workspace does not hold: ` +
        `${[...new Set(missing)].join(', ')}.\n` +
        `  Connections live in connections.yaml. Run "lanes link connection list" to see them.`,
    );
  }

  const seen = new Set<string>();
  const duplicated = config.grants
    .map((grant) => grant.connection)
    .filter((ref) => (seen.has(ref) ? true : (seen.add(ref), false)));

  if (duplicated.length > 0) {
    throw new ConfigError(
      `Profile "${config.instance.profile}" grants the same connection more than once: ` +
        `${[...new Set(duplicated)].join(', ')}.\n` +
        `  One row per connection — merge the allow and deny lists into it.`,
    );
  }
}

/**
 * No two connections in a workspace share a reference.
 *
 * `<provider>.<id>` is what a credential ref is derived from and what an agent
 * names, so a duplicate is two accounts answering to one address. It was
 * impossible to express before contract 3 only because a profile held its own
 * list; one workspace-wide list makes it expressible, so it has to be refused.
 */
export function assertConnectionsUnique(connections: readonly ConnectionConfig[]): void {
  const seen = new Set<string>();
  const duplicated = connections
    .map(connectionRefOf)
    .filter((ref) => (seen.has(ref) ? true : (seen.add(ref), false)));

  if (duplicated.length > 0) {
    throw new ConfigError(
      `connections.yaml declares the same connection more than once: ` +
        `${[...new Set(duplicated)].join(', ')}.\n` +
        `  A connection is addressed as "<provider>.<id>", so two rows sharing one ` +
        `are two accounts at one address.`,
    );
  }
}

/**
 * The one connection this profile grants for a single-instance provider.
 *
 * `undefined` when it grants none, which is a legitimate state: a profile that
 * denies `skills.*` reaches no skills, and the surface is absent rather than
 * empty.
 */
export function soleGrantFor(config: Config, provider: string): string | undefined {
  const prefix = `${provider}.`;
  const granted = config.grants.find((grant) => grant.connection.startsWith(prefix));
  return granted?.connection.slice(prefix.length);
}

/**
 * A connection whose provider id moved out from under it.
 *
 * `tasks` is the built-in task list; Google's is `google_tasks` (ADR-051). A row
 * that still says `tasks` and names an address rather than the built-in's own
 * label is somebody's Google account resolving to the wrong provider — and the
 * failure is silent in the worst way: the row loads, reconcile calls it active,
 * and every call goes to an empty local store.
 *
 * Here rather than in the profile loader, because the evidence is the *account*
 * and accounts live in this file.
 */
export function assertNoRenamedProviders(
  connections: readonly ConnectionConfig[],
  repair: string,
): void {
  const problems = connections.flatMap((connection, index) => {
    const renamed = describeRename(connection, repair);
    return renamed === null ? [] : [`connections[${index}]: ${renamed}`];
  });

  if (problems.length > 0) {
    throw new ConfigError(`connections.yaml:\n${problems.map((p) => `  ${p}`).join('\n')}`, problems);
  }
}
