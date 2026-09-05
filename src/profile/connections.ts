import { ConfigError, describeRename } from './load.ts';
import type { Config, ConnectionConfig, GrantConfig, TargetConfig } from './schema.ts';

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
 * What to call a connection nobody has named.
 *
 * `label` is the operator's own word for a row and is usually unset: `connect`
 * offers a default and does not write one that only repeats a line above it, so
 * most rows are an id, a provider and an account and nothing else. Every reader
 * then has to decide what to show, and each of them picked the id — which is the
 * one field that says nothing. It is opaque on purpose (`nextConnectionId`), so
 * `con8` tells a reader strictly less about a row than any other line of it.
 *
 * The provider is what somebody is asking about, and the account is what tells
 * two rows of the same provider apart, so the name is both: `Gmail (ada)`. The
 * local part only — every address a person holds at one domain repeats it, and
 * the account itself is on the line beside this everywhere this is shown.
 *
 * A connection with no account behind it is its provider and nothing else. That
 * is the owner layer, whose rows carry the proper noun in `account` already, so
 * composing the two would read `Memory (Memory)`.
 */
export function defaultConnectionLabel(
  providerName: string,
  account: string | null | undefined,
): string {
  if (!account || account === providerName) return providerName;

  // A qualified account — `ada (Acme)`, the shape an identity block writes when
  // one name spans two tenants — is shortened on the name and keeps the
  // bracket. Without this, two Notion workspaces resolve to the same address
  // and shorten to the same label, so the field that exists to tell them apart
  // is the one the reader never sees.
  const qualified = /^(.*?)\s+(\([^()]*\))$/.exec(account);
  const identity = qualified?.[1] ?? account;
  const qualifier = qualified?.[2] ? ` ${qualified[2]}` : '';

  // Split on `@` and nothing else. A handle, an IBAN or a workspace name has no
  // "first part" that is safe to guess at: `Lanes HQ` cut at the space is
  // `Lanes`, which is a different workspace's name as often as not.
  const local = identity.split('@')[0];
  return `${providerName} (${local || identity}${qualifier})`;
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
 * Two accounts are the same account, for the purpose of finding a row again.
 *
 * Trimmed as well as lower-cased. The match this serves used to lower-case
 * inline and stop there, and nothing trims on the way in either — so a probe
 * that returned `" ada@example.com"`, or an operator who typed a trailing
 * space, matched no row and got a second one beside the first.
 */
export function sameAccount(one: string, other: string): boolean {
  return one.trim().toLowerCase() === other.trim().toLowerCase();
}

/**
 * The row this provider already holds for this account, if it holds one.
 *
 * **The uniqueness rule, in the one place both callers ask it.** A connection is
 * unique on its provider and its account: the label is displayed and addressed
 * by nothing, and the id is opaque and allocated. So connecting an account a
 * second time is not a new connection, it is the same one — a rotated password,
 * an expired token, an attempt that failed halfway — and it overwrites the row
 * that is already there.
 *
 * It is a function rather than two comparisons because the two comparisons
 * disagreed. `settleIdentity` chose the id by matching the account across a
 * whole vendor, `declareConnection` found the row to write by `<provider>.<id>`,
 * and where those resolved differently the writer appended: an iCloud mailbox
 * reconnected onto the calendar's id, found no mail row under it, and left the
 * old row stale beside the new one.
 */
export function connectionForAccount(
  connections: readonly ConnectionConfig[],
  providerId: string,
  account: string,
): ConnectionConfig | undefined {
  return connections.find(
    (connection) => connection.provider === providerId && sameAccount(connection.account, account),
  );
}

/**
 * Rows that are the same connection twice, for a reader who already has some.
 *
 * Reported rather than refused, and the distinction is the whole reason this is
 * not part of `assertConnectionsUnique` above. Two rows at one `<provider>.<id>`
 * are unresolvable, so that one throws at load. Two rows for one account both
 * work — one is merely stale — and refusing those at load would run on every
 * read and on every `ConfigDocument.open`, which would take a workspace that
 * already holds a pair off the air and refuse `disconnect` the very file that
 * fixes it.
 */
export function duplicateAccountRows(
  connections: readonly ConnectionConfig[],
): ConnectionConfig[][] {
  const groups = new Map<string, ConnectionConfig[]>();

  for (const connection of connections) {
    const key = `${connection.provider} ${connection.account.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), connection]);
  }

  return [...groups.values()].filter((group) => group.length > 1);
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
 * Where this profile's vault document lives, in one spelling.
 *
 * **Two places derived this, and they disagreed.** `openVault` names it per
 * connection (ADR-059) — `vault/main` for a profile granting `vault.main` — and
 * the deploy's provisioning step named `vault/document`, the contract-2 constant.
 * So every deployed workspace that did not hand-write `vault.ref` created and
 * granted one secret and then asked Secret Manager for another: the revision got
 * `PERMISSION_DENIED` on the ref nothing had made, exited 1, and never listened
 * on its port. A deploy that hand-wrote a `ref` worked, which is what kept this
 * out of sight — a rehearsal that sets one is testing the path nobody takes.
 *
 * `ref` still wins where it is written, because a deployment already sealing
 * under one name has to keep opening it.
 */
export function vaultRef(declared: TargetConfig | undefined, config: Config): string {
  // **The profile, then the connection.** This was `vault/<connection>`, which
  // was distinct per profile only while each profile had its own vault
  // instance. ADR-066 merges the owner layer to one row per surface, so every
  // profile grants `lanes_vault.lan5` and every profile opened one sealed
  // document — `vault_put` from `personal` overwriting `work`'s item of the
  // same id, and `vault_get` reading the other profile's credential. The `file`
  // and `blob` adapters take the profile from `layout`; this is the same fact
  // for the adapter every deployment uses.
  //
  // A `ref` the target states outright still wins: a deployment already sealing
  // under one name has to keep opening it.
  const connection = soleGrantFor(config, 'lanes_vault') ?? 'main';
  return declared?.vault?.ref ?? `vault/${config.instance.profile}/${connection}`;
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
