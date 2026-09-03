import { BearerAuthenticator, ownerPrincipal } from '#auth';
import type { SecretStore } from '#secrets';
import type { AuditReader } from '#audit';
import { DISCOVERY_NAMESPACE, type RuntimeState } from '#stores/state';
import type { BlobStore } from '#stores/blobs';
import type { AnyConnector, ProviderManifest } from '#connectivity';
import { RateLimiter, allowedConnections } from '#policy';
import {
  assertGrantsResolve,
  layout,
  listProfiles,
  membersResolver,
  readConnections,
  selectConnections,
  soleGrantFor,
  workspacePath,
  type Config,
  type ConnectionConfig,
  type Resolution,
  type SelectedConnection,
  type TargetConfig,
} from '#profile';
import { ProviderRegistry, toPolicyDocument } from '#registry';
import { Dispatcher, createConsoleLogger } from '#dispatch';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import type { VaultStore } from '#providers/owner.ts';
import {
  openAuditSinks,
  openState,
  openSecrets,
  openStorage,
  type StorageFactory,
  type TargetInput,
} from '#deployments/target.ts';
import { knowledgeRoutes, openKnowledge, type FetchLike, type KnowledgeStores } from '#deployments/knowledge.ts';
import { routeBlobStore } from '#stores/blobs/route.ts';
import { connectorFactory } from '#connectivity/transports';
import { requestAuthorizer } from '#connectivity/auth/index.ts';
import { resolveProfile, type GlobalFlags } from './select.ts';
import { buildRegistryWithWorkspace, readSkillsForStart, reloadSkills } from './registry.ts';
import { discoveryProbe } from './discovery.ts';
import { openVault } from './vault.ts';
import { EMPTY_SKILL_STORE, skillStore } from './stores.ts';
import type { Runtime } from './types.ts';

export type { Runtime } from './types.ts';

/**
 * Assembling a profile's runtime from its declared target.
 *
 * The same config can run in more than one place; a target names an adapter
 * set. Connections, providers, policy, and limits are declared once and apply
 * to every target — only the adapters differ, which is what lets M2 change
 * nothing at the application layer.
 */

/**
 * The accounts a profile reaches, as most callers want them.
 *
 * `runtime.connections` pairs each with the grant governing it, which is what
 * policy and the setup surface need. Everything else — probing credentials,
 * listing accounts, reconciling state — wants the rows alone, and unwrapping
 * them at twenty call sites is twenty chances to reach for
 * `workspaceConnections` by mistake and answer for accounts this profile was
 * never granted.
 */
export function grantedConnections(
  runtime: Pick<Runtime, 'connections'>,
): ConnectionConfig[] {
  return runtime.connections.map(({ connection }) => connection);
}

/**
 * What a caller may hand the runtime that is not a flag somebody typed.
 *
 * One field, and it exists for the same reason `connect`'s does: the only thing
 * a runtime reaches over the network at open time is a knowledge repository,
 * and a test that could not replace it would either hit github.com or not run.
 */
export interface OpenOptions {
  /** Injected for tests. */
  readonly fetch?: FetchLike | undefined;
}

export async function openRuntime(
  flags: GlobalFlags,
  options: OpenOptions = {},
): Promise<Runtime> {
  const { resolution, config, target, resolved } = await resolveProfile(flags);
  // `resolveProfile` returns this for every caller that did not ask to create
  // the target, and `openRuntime` never does — a runtime for a target that does
  // not exist yet has nothing to open. The check is what makes that readable at
  // the type level rather than a comment.
  if (!resolved) throw new Error(`Target "${target}" has nothing to open yet`);

  const declared = resolved.declared;
  const root = resolved.workspaceRoot;
  const adapters: TargetInput = { declared, config, root, target };

  // The workspace's accounts, and the check that this profile's grants name
  // real ones (ADR-057). Read here rather than inside `resolveProfile` because
  // it is a property of the workspace rather than of the selection, and because
  // a command that only wants to know which profiles exist should not have to
  // parse every connection to find out.
  const connectionsFile = await readConnections(root);
  assertGrantsResolve(config, connectionsFile.connections);
  const selected = selectConnections(config, connectionsFile.connections);

  // Credentials first: an S3 key pair is itself a credential reference, so the
  // credential store has to exist before the blob store that names it. State
  // and the log then ride that blob store rather than opening backends of
  // their own, which is why there is no migrate step here any more — there is
  // no schema left to migrate.
  const credentials = await openSecrets(adapters);
  const storageFor = await openStorage(adapters, credentials);

  // Memory and skills, where a profile keeps them somewhere else (ADR-041).
  //
  // The redirection happens *here*, on the store every consumer was already
  // handed, and that is deliberate. Memory is not addressed by a name anything
  // declares: `buildProviderContext` scopes the profile's blob root to
  // `memory/<connection>`, and `lanes link memory` reaches the same bytes by
  // calling the same two functions. So the dispatcher, the provider, and the
  // CLI need no knowledge of this and cannot disagree about where an entry
  // went — the one thing they are handed already points at the repository.
  //
  // The audit log, `state.kv`, the credential store and the vault keep their
  // own roots on the target's own storage and are untouched.
  const knowledge = await openKnowledge(adapters, credentials, options.fetch);
  const storage = knowledge ? routeBlobStore(storageFor(), knowledgeRoutes(knowledge)) : storageFor();
  const state = openState(storageFor, config.instance.profile);

  // The durable log, plus any copies the target declares. `sink` is what
  // dispatch writes to; `audit` is what `tail` and `verify` read, and those are
  // not the same object once a fan-out exists — a copy is not the log.
  const logger = createConsoleLogger(flags.quiet ? 'error' : 'info');
  const { sink: auditSink, reader: audit } = await openAuditSinks(
    adapters,
    storageFor,
    credentials,
    (message) => logger.warn(message),
  );

  // Rooted at the skills connection this profile grants, not at the profile
  // (ADR-059). At most one can be granted, which is what makes this a lookup
  // rather than a choice — `load.ts` refuses a second one, for the reason a
  // prompt has no argument to route on.
  //
  // `EMPTY_SKILLS` when none is granted: a profile that denies `skills.*` has
  // no store to open, and handing it the workspace root instead would serve
  // every other profile's procedures.
  const skillsConnection = soleGrantFor(config, 'lanes_skills');
  const skills =
    knowledge?.skills ??
    (skillsConnection === undefined ? undefined : skillStore(storageFor, config.instance.profile, skillsConnection));

  // The vault's own store, beside the credential store and never it: a separate
  // document, a separate key, and a separate environment variable
  // (`LANES_LINK_VAULT_KEY`). One master secret reused across purposes turns any
  // single compromise into a total one — `https://lanes.sh/docs/link/security`, and the boundary
  // test that has existed since M1.
  //
  // Opened before the registry because each stored item becomes its own
  // `vault.get.<id>` capability, which is what makes per-item policy
  // expressible; an item written since the last start is therefore not readable
  // until the next one, deliberately (ADR-012 §3).
  const vaultStore = openVault(adapters, storageFor, credentials);

  // `refreshSkills` is declared before the registry it mutates because the
  // provider has to be handed it at construction: a `skills.manage.write` says
  // that something changed, and this is what that means. It is only ever
  // *called* after the registry exists.
  let registry: ProviderRegistry;
  let fingerprint = '';
  const refreshSkills = async (): Promise<void> => {
    if (skills === undefined) return;
    fingerprint = await reloadSkills(registry, skills, fingerprint, refreshSkills);
  };

  // Computed before the registry because the setup surface is handed a way to
  // ask what this principal may reach — through the *same* `allowedConnections`
  // the dispatcher enforces with and `mergeCapabilities` builds the connection
  // enum from. Computing visibility a second way is how discovery and
  // enforcement drift, and a leak in discovery is still a leak.
  const policy = toPolicyDocument(config);
  // The owner, explicitly, rather than assumed: when a delegated principal
  // arrives this becomes the seam, and `reachable` grows a parameter instead of
  // being rewritten.
  const principal = ownerPrincipal(config.instance.profile).id;

  // Lazy for the same reason `refreshSkills` is: it reads the registry it is
  // registered into. Per call rather than a snapshot, so a policy the runtime
  // was opened with is re-evaluated rather than remembered.
  const reachable = (): ReadonlyArray<{
    key: string;
    provider: string;
    providerName: string;
    account: string;
  }> =>
    selected
      .filter(({ ref, connection }) =>
        registry
          .capabilities()
          .some(
            ({ id }) =>
              id.startsWith(`${connection.provider}.`) &&
              allowedConnections(id, [ref], principal, policy).length > 0,
          ),
      )
      .map(({ ref, connection }) => ({
        key: ref,
        provider: connection.provider,
        // The manifest's display name, not the id. `defaultConnectionLabel`
        // composes "Gmail (ada)" and needs the name — handed the id it produces
        // "gmail (ada)", and for the owner layer, whose `account` is already the
        // proper noun, "lanes_memory (Memory)".
        providerName: registry.manifest(connection.provider)?.name ?? connection.provider,
        account: connection.account,
        ...(connection.label ? { label: connection.label } : {}),
      }));

  // Read before the registry is built, so a store that cannot be reached is a
  // warning rather than the end of the process — see `readSkillsForStart`. Only
  // tolerated when the store is a repository: a local directory that will not
  // read is a real fault worth failing on, exactly as it always was.
  const loaded = await readSkillsForStart(
    skills ?? EMPTY_SKILL_STORE,
    knowledge !== undefined,
    (message) => logger.warn(message),
    ` --profile ${config.instance.profile} --workspace ${target}`,
  );

  registry = await buildRegistryWithWorkspace(root, {
    ...(skills ? { skillStore: skills } : {}),
    skills: loaded.skills,
    onSkillsChanged: refreshSkills,
    vault: { store: vaultStore, items: await vaultStore.ids() },
    setup: {
      profile: config.instance.profile,
      target,
      profiles: await listProfiles(root),
      catalogue: PROVIDER_MANIFESTS,
      ownClients: Object.keys(connectionsFile.oauth_apps),
      reachable,
    },
    // Straight off the config: unlike `reachable`, nothing has to be filtered
    // through policy first. Whether the surface is reachable at all is still
    // policy's answer, given once by `mergeCapabilities` — this only decides
    // what it says when it is.
    identity: { profile: config.instance.profile, target, entries: config.identity },
  });
  // Seeded from the read above, so the first refresh compares against what is
  // registered rather than rebuilding once to find out.
  fingerprint = loaded.fingerprint;

  // Discovered capabilities never come from a live call on the dispatch path —
  // that is what keeps the server stateless. But "not live" is not the same as
  // "cached", and conflating the two was a bug: `connect` was the only writer of
  // this cache, so an operator who upgraded without re-authorising kept whatever
  // their last consent screen happened to discover. Drive shipped nine
  // operations and served six; Gmail served a `drafts.create` this repository
  // had deleted, because the spec is read by the tests and the cache is read by
  // the endpoint.
  //
  // So: derive it where deriving is free, and cache it only where it is not. An
  // `http` provider's capabilities are a pure function of a document committed
  // here — reviewed in a diff, not fetched from a vendor — which is the property
  // that makes re-deriving safe as well as cheap.
  for (const entry of registry.list()) {
    if (entry.manifest.connector.kind === 'local') continue;

    const probe = discoveryProbe(entry.manifest);
    if (probe?.cost === 'offline') {
      try {
        registry.setDiscovered(entry.manifest.id, await probe.run());
        continue;
      } catch {
        // A malformed committed spec is a build problem, not a reason to refuse
        // to start — fall through to whatever the cache last held.
      }
    }

    const cached = await state.kv.get(DISCOVERY_NAMESPACE, entry.manifest.id);
    if (cached) {
      try {
        registry.setDiscovered(entry.manifest.id, JSON.parse(cached));
      } catch {
        // A corrupt cache entry means "not discovered yet", which `plan`
        // reports and `connect` fixes — never a reason to fail startup.
      }
    }
  }

  // One factory for the whole runtime, so its cache actually holds. The
  // dispatcher and the CLI share it deliberately: a stateful connector must be
  // the *same instance* whichever side asks for it, or a held session is held
  // twice.
  const connectorFor = connectorFactory({
    registry,
    credentials,
    // From the connection row, which is where a per-connection setting has
    // always lived. One lookup behind both, so they cannot disagree.
    connectionConfig: (provider, id) => row(connectionsFile.connections, provider, id)?.config,
    isDeclared: (provider, id) => row(connectionsFile.connections, provider, id) !== undefined,
  });
  const authorizeRequest = requestAuthorizer(registry, credentials);
  let closed = false;

  const dispatcher = new Dispatcher({
    config,
    connections: connectionsFile.connections,
    oauthApps: Object.keys(connectionsFile.oauth_apps),
    registry,
    connectorFor,
    authorizeRequest,
    policy,
    state,
    audit: auditSink,
    credentials,
    storage,
    limiter: new RateLimiter(),
    log: logger,
  });

  return {
    resolution,
    config,
    target,
    declared,
    connections: selected,
    workspaceConnections: connectionsFile.connections,
    ownClients: Object.keys(connectionsFile.oauth_apps),
    state,
    audit,
    credentials,
    storage,
    skills,
    ...(knowledge ? { knowledge } : {}),
    vault: vaultStore,
    registry,
    refreshSkills,
    dispatcher,
    // The workspace's issued tokens, not a profile's (ADR-068). The rows are
    // re-read on every reload so a `token revoke` lands inside the cache
    // window, and the subject on the matching row is resolved through
    // `members:` — so a bearer token reaches what its holder is a member of
    // rather than everything the workspace holds.
    authenticator: new BearerAuthenticator({
      profile: config.instance.profile,
      tokens: async () => (await readConnections(root)).tokens,
      credentials,
      profilesFor: membersResolver(root),
    }),
    connectorFor,
    authorizeRequest,
    manifestFor: (providerId: string) => registry.manifest(providerId),
    // Sessions first, then the state: a connector may still want to log out
    // cleanly, and LOGOUT is worth more than the microsecond it costs.
    //
    // Idempotent, because a command that finishes early closes explicitly and
    // its `finally` then closes again — and closing a SQLite handle twice is an
    // error that would surface as a crash after the work already succeeded.
    close: async () => {
      if (closed) return;
      closed = true;
      await connectorFor.closeAll();
      // Closing the log is not releasing a handle: it writes the marker that
      // lets `audit verify` tell a run that ended from one whose tail was cut
      // off. A crash leaves the run open, which is the honest outcome.
      await auditSink.close();
    },
  };
}

const row = (connections: readonly ConnectionConfig[], provider: string, id: string) =>
  connections.find((connection) => connection.provider === provider && connection.id === id);
