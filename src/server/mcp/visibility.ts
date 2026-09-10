import { READ_BUNDLE, RESERVED_PROVIDER_IDS, isTool } from '#connectivity';
import type { Principal } from '#auth';
import type { Config, SelectedConnection } from '#profile';
import type { ProviderRegistry } from '#registry';
import type { Dispatcher } from '#dispatch';
import type { PolicyDocument, ProfilePolicy } from '#policy';
import { allowedConnections } from '#policy';
import { mayReach } from '#auth';
import { SURFACE_TOOL_NAMES, toolNameFor } from './naming.ts';

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
  /**
   * How much of the reachable surface is advertised. See `config.surface`.
   *
   * Absent means `full`, which is what every caller that does not set it gets
   * and what this endpoint served before the option existed. Taken from the
   * primary profile, because `tools/list` is the union across profiles and a
   * union has one shape.
   */
  readonly surface?: 'full' | 'crunched' | undefined;
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
  /**
   * Whether this capability only reads, as the provider itself classified it.
   *
   * The endpoint has always known this and never said so. Every connector
   * assigns a bundle — an `mcp` provider from the upstream tool's own
   * `readOnlyHint`, an `http` one from the request method, an authored one from
   * the manifest — and policy has used it to decide grants since the beginning.
   * It just never reached the wire, so a client had to assume the worst about
   * every tool here: reading a stored file was advertised with the same posture
   * as deleting one, and a client offering to auto-approve harmless calls could
   * never find any.
   *
   * Carried on the merged entry rather than looked up at registration, because
   * three places need it and only this one holds the registry.
   */
  readonly reads: boolean;

  /**
   * The arguments that ask this capability's provider for a smaller record.
   * Resolved here for the same reason `reads` is: the gateway that fills in a
   * list holds the merged entry and not the registry.
   */
  readonly compact?: Readonly<Record<string, unknown>>;
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

      merged.set(id, {
        reachable: new Map([[name, reachable]]),
        capability,
        discovered,
        reads: readsOnly(id, discovered, runtime.registry),
        ...compactFor(id, capability, discovered, runtime.registry),
      });
    }
  }

  return merged;
}

/**
 * Whether a capability only reads, taken from the provider rather than guessed.
 *
 * Two sources, one answer. A discovered capability carries the bundle its
 * connector assigned it — from the upstream tool's `readOnlyHint` for an `mcp`
 * provider, from the HTTP method for an `http` one. An authored capability is
 * named in a bundle in its own manifest, which the registry can expand.
 *
 * Deliberately not inferred from the capability's name here, though the ranking
 * does exactly that for ordering. Ordering may guess; an advertised hint about
 * whether a call is safe may not, because a client is entitled to relax a
 * confirmation on the strength of it. Where the provider did not say, this says
 * nothing either, and the caller keeps the cautious default.
 */
function readsOnly(
  id: string,
  discovered: ReturnType<ProviderRegistry['capabilities']>[number]['discovered'],
  registry: ProviderRegistry,
): boolean {
  if (discovered?.bundle !== undefined) return discovered.bundle === READ_BUNDLE;

  const [provider] = id.split('.');
  if (provider === undefined) return false;
  return registry.expandBundle(provider, READ_BUNDLE).includes(id);
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
  // The stable-name pair is advertised unconditionally and is not a
  // capability, so it is in `tools/list` and not in `merged` — see
  // `SURFACE_TOOL_NAMES`.
  return SURFACE_TOOL_NAMES.length + advertisedTools(mergeCapabilities(options), options.surface).size;
}

/** Whether this entry registers as a tool, as `buildMcpServer` decides it. */
function registersAsTool(entry: MergedCapability): boolean {
  return entry.discovered ? true : !!entry.capability && isTool(entry.capability);
}

/** Whether this capability belongs to the owner layer — the endpoint's own material. */
function isOwnerLayer(capabilityId: string): boolean {
  const dot = capabilityId.indexOf('.');
  return RESERVED_PROVIDER_IDS.includes(dot === -1 ? capabilityId : capabilityId.slice(0, dot));
}

/**
 * Which reachable capabilities get a typed tool of their own.
 *
 * The one evaluation three places consume — the registration loop in
 * `build.ts`, the count `/reload` returns, and the visible set that decides
 * whether a call is recorded as a refusal. They were separate before there was
 * anything to disagree about; a mode that advertises less than it can reach is
 * exactly the thing that makes them able to drift, so they share this.
 *
 * `crunched` keeps the owner layer and nothing else. That line is not a
 * shortlist someone tuned: the owner layer is the material this endpoint holds
 * itself rather than anybody's API, it is small, and the instructions name
 * several of its tools directly — an agent is told to call `lanes_setup_overview`
 * before saying something cannot be reached, and `lanes_entities.find` before
 * using anyone's address. Advertising less than this would leave those
 * sentences pointing at tools the client cannot see.
 *
 * Everything omitted stays in `merged`, which is what `lanes_tools_call`
 * dispatches against — so it is still reachable, still policy-checked, still
 * audited. Omission is exposition, not authority. `grants:` is the lever that
 * changes authority, and it removes the capability from `merged` entirely.
 */
export function advertisedTools(
  merged: ReadonlyMap<string, MergedCapability>,
  surface: 'full' | 'crunched' | undefined,
): ReadonlySet<string> {
  const advertised = new Set<string>();

  for (const [id, entry] of merged) {
    if (!registersAsTool(entry)) continue;
    if (surface === 'crunched' && !isOwnerLayer(id)) continue;
    advertised.add(id);
  }

  return advertised;
}

/**
 * Every wire name the built server will answer, for the refusal audit.
 *
 * Not `visibleCapabilities().map(toolNameFor)` any more: that was the same set
 * while everything reachable was advertised, and stops being so under
 * `crunched`. A name in this set and not on the wire means a call to it is
 * answered by the SDK and recorded nowhere, which is the half of the drift that
 * fails silently.
 *
 * Resources and prompts are unaffected by the mode and stay in regardless — a
 * skill is a prompt (ADR-032), and neither was ever on the tool count.
 */
export function advertisedNames(options: BuildServerOptions): string[] {
  const merged = mergeCapabilities(options);

  // Identical to what this returned before the option existed, deliberately:
  // `full` must not be a different code path that happens to agree.
  if (options.surface !== 'crunched') return [...merged.keys()].map(toolNameFor);

  const advertised = advertisedTools(merged, options.surface);
  const names: string[] = [];

  for (const [id, entry] of merged) {
    if (registersAsTool(entry) && !advertised.has(id)) continue;
    names.push(id);
  }

  return names.map(toolNameFor);
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

/**
 * The projection a provider declared for one capability, if it declared one.
 * Keyed by the unqualified name, exactly as `redact` and `hints` are.
 */
function compactFor(
  id: string,
  capability: ReturnType<ProviderRegistry['capabilities']>[number]['capability'],
  discovered: ReturnType<ProviderRegistry['capabilities']>[number]['discovered'],
  registry: ProviderRegistry,
): { compact?: Record<string, unknown> } {
  const [provider] = id.split('.');
  const name = capability?.name ?? discovered?.name;
  if (provider === undefined || name === undefined) return {};

  // Spread rather than assigned, because `exactOptionalPropertyTypes` refuses
  // an explicit `undefined` where the field is declared optional.
  const compact = registry.manifest(provider)?.compact?.[name];
  return compact === undefined ? {} : { compact };
}
