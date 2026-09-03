import { isTool } from '#connectivity';
import type { Principal } from '#auth';
import type { Config, SelectedConnection } from '#profile';
import type { ProviderRegistry } from '#registry';
import type { Dispatcher } from '#dispatch';
import type { PolicyDocument, ProfilePolicy } from '#policy';
import { allowedConnections } from '#policy';
import { mayReach } from '#auth';

/**
 * What this principal can see, and therefore what gets registered at all.
 *
 * The server is a pure function of resolved policy: a capability the principal
 * cannot reach on any connection is not registered, and one it can reach on some
 * connections advertises exactly those in its `connection` enum. A client
 * therefore cannot discover a connection it has no grant for.
 *
 * Discovery filtering and invocation enforcement share one implementation
 * (`allowedConnections`, which calls the same `evaluate` the dispatcher uses).
 * If they were computed separately they could drift, and a leak in discovery is
 * still a leak.
 */

/** Everything one profile contributes to the endpoint. */
export interface ProfileRuntime {
  readonly config: Config;
  /**
   * The accounts this profile selects, for the `connection` argument's
   * description — the id alone cannot say which mailbox it is.
   *
   * Optional because a registry built to read manifests has no selection, the
   * same reason `refreshSkills` is: a harness that omits it gets bare ids, which
   * is what this listed for everybody before.
   */
  readonly connections?: readonly SelectedConnection[];
  readonly registry: ProviderRegistry;
  readonly dispatcher: Dispatcher;
  readonly policy: ProfilePolicy;
  readonly floor?: PolicyDocument | undefined;
  /**
   * Re-read the skills into `registry`, if they have changed on the store.
   *
   * Optional because only a served endpoint has one — a registry built to read
   * manifests has nothing to refresh. Cheap and idempotent; the endpoint decides
   * how often to ask (ADR-014).
   */
  refreshSkills?(): Promise<void>;
}

export interface BuildServerOptions {
  /**
   * Every profile this endpoint serves, keyed by name.
   *
   * One port, several profiles, and `profile` injected into each tool beside
   * `connection`. What this trades away is worth naming: a token used to open
   * exactly one profile, so a leaked one reached exactly one set of accounts.
   * Now a single token reaches all of them and the *caller* chooses, which makes
   * cross-profile access a matter of what the model decides to pass. Policy is
   * still enforced per profile, and every call records which one.
   */
  readonly profiles: ReadonlyMap<string, ProfileRuntime>;
  readonly principal: Principal;
  /** Self-reported by the client. Recorded in audit; never used to authorize. */
  readonly clientLabel?: string | undefined;
  readonly version?: string;
  /**
   * Whether this endpoint publishes an authorization surface, and therefore
   * serves clients that arrived by URL alone.
   *
   * Read only by the instructions, which gain a paragraph for them. Absent over
   * a pipe and on a loopback endpoint, where the client holds the skill and the
   * transport cannot fail the way this describes.
   */
  readonly remoteClients?: boolean | undefined;
}

/** One profile as the map the builder wants. */
export function oneProfile(
  name: string,
  runtime: ProfileRuntime,
): ReadonlyMap<string, ProfileRuntime> {
  return new Map([[name, runtime]]);
}

/**
 * The connections this profile can reach at all, before policy narrows further.
 *
 * The grant rows *are* the answer (ADR-058). A profile reaches what it grants
 * and nothing else, so this needs no view of the workspace's connections — which
 * is the useful half of decoupling them: what a profile can see is written in
 * the profile, and cannot widen when somebody connects a new account.
 */
function connectionsOf(runtime: ProfileRuntime): string[] {
  return runtime.config.grants.map((grant) => grant.connection);
}

/**
 * What each profile exposes of one capability, merged.
 *
 * A capability is registered once even when several profiles offer it — two
 * mailboxes are still one `gmail.users.messages.list` tool — with the profile
 * chosen per call. `reachable` stays per profile because the connection enum
 * must not imply that an account of one profile can be used through another.
 */
export interface MergedCapability {
  readonly reachable: Map<string, string[]>;
  readonly capability: ReturnType<ProviderRegistry['capabilities']>[number]['capability'];
  readonly discovered: ReturnType<ProviderRegistry['capabilities']>[number]['discovered'];
}

export function mergeCapabilities(options: BuildServerOptions): Map<string, MergedCapability> {
  const merged = new Map<string, MergedCapability>();

  for (const [name, runtime] of options.profiles) {
    // The same list the dispatcher enforces with. A member does not merely fail
    // to call a profile they are not on — it is absent from the `profile` enum,
    // so they never learn it exists (ADR-060). Discovery and enforcement share
    // one answer here for the same reason they share `allowedConnections`.
    if (!mayReach(options.principal, name)) continue;

    const connections = connectionsOf(runtime);

    for (const { id, capability, discovered } of runtime.registry.capabilities()) {
      const reachable = allowedConnections(
        id,
        connections,
        options.principal.id,
        runtime.policy,
        runtime.floor,
      );
      if (reachable.length === 0) continue;

      const existing = merged.get(id);
      if (existing) {
        existing.reachable.set(name, reachable);
        continue;
      }

      merged.set(id, { reachable: new Map([[name, reachable]]), capability, discovered });
    }
  }

  return merged;
}

/** Which capability ids this principal can reach, across every profile served. */
export function visibleCapabilities(options: BuildServerOptions): string[] {
  return [...mergeCapabilities(options).keys()];
}

/**
 * How many of those are tools, as `tools/list` would count them.
 *
 * Not the same number as `visibleCapabilities().length`, and the difference is
 * the kind of thing that only shows up when someone reads it: a reachable
 * capability may register as a resource or a prompt instead, so counting ids
 * and calling the answer "tools" overstates the list by however many of those
 * a profile has. The kind is decided here exactly as `buildMcpServer` decides
 * it — a discovered capability is always a tool, an authored one is asked.
 */
export function visibleToolCount(options: BuildServerOptions): number {
  let count = 0;

  for (const entry of mergeCapabilities(options).values()) {
    if (entry.discovered) count += 1;
    else if (entry.capability && isTool(entry.capability)) count += 1;
  }

  return count;
}

/**
 * Say which accounts are reachable, grouped by profile.
 *
 * Grouped rather than flattened because the two arguments are not independent:
 * `profile: personal` with a connection belonging to `work` is refused, and a
 * flat list would read as though any pairing were valid.
 *
 * **The account, not just the id.** This listed bare ids, and the id is the
 * only thing a model has to choose on — so two accounts of one vendor were
 * `ada_lovelace` and `ada_lovelace2` and nothing said which mailbox either was.
 * `idFromAccount` takes only the local part, so that is what two addresses at
 * different domains actually produce. Picking the wrong one sends mail as the
 * wrong person, which is the same class of failure ADR-056 rules out for
 * entities: ordering is not selection, and a caller that cannot tell two
 * candidates apart must be given what tells them apart.
 *
 * **The key is the grant ref, not the bare id.** `connectionsOf` fills the enum
 * from the grant rows (ADR-058), so `reachable` carries `gmail.con1`, and
 * `accountsByProfile` keys on that same `ref` — one string from one source, so
 * the two sides cannot drift. Keyed on `connection.id` instead it missed every
 * lookup, and no served description carried an account at all, while
 * `connection-choice.test.ts` passed bare ids in by hand and stayed green.
 * Contract 4 is what turned that from cosmetic into a real loss: the ids used to
 * carry the account and are `con1`, `con2` now, so the id says nothing about
 * which mailbox it is and this annotation is the only thing that does.
 */
export function describeWithConnections(
  description: string,
  reachable: ReadonlyMap<string, readonly string[]>,
  accounts: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): string {
  const lines = [...reachable].flatMap(([profile, connections]) => {
    const known = accounts.get(profile);
    return [
      `  ${profile}:`,
      ...connections.map((id) => `    ${id}${known?.get(id) === undefined ? '' : ` — ${known.get(id)!}`}`),
    ];
  });
  return `${description}\n\nAvailable connections, by profile:\n${lines.join('\n')}`;
}

/**
 * How each profile's connections should read to a caller choosing between them.
 *
 * `account` always, `label` where the operator set one — the two fields that
 * exist because the id cannot carry meaning and must not pretend to.
 */
export function accountsByProfile(
  options: BuildServerOptions,
): Map<string, Map<string, string>> {
  const accounts = new Map<string, Map<string, string>>();

  for (const [name, runtime] of options.profiles) {
    const rows = new Map<string, string>();
    for (const { ref, connection } of runtime.connections ?? []) {
      rows.set(
        ref,
        connection.label === undefined
          ? connection.account
          : `${connection.account} (${connection.label})`,
      );
    }
    accounts.set(name, rows);
  }

  return accounts;
}
