import { BearerAuthenticator, ownerPrincipal } from '#auth';
import type { SecretStore } from '#secrets';
import type { AuditReader } from '#audit';
import type { RuntimeState } from '#stores/state';
import type { BlobStore } from '#stores/blobs';
import type { AnyConnector, ProviderManifest } from '#connectivity';
import { RateLimiter, allowedConnections } from '#policy';
import {
  ConfigError,
  layout,
  listProfiles,
  workspacePath,
  type Config,
  type Resolution,
} from '#profile';
import { ProviderRegistry, toPolicyDocument } from '#registry';
import { Dispatcher, createConsoleLogger } from '#dispatch';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import {
  createBlobVaultStore,
  createFileVaultStore,
  createSecretVaultStore,
  type VaultStore,
} from '#providers/owner.ts';
import {
  openAuditSinks,
  openState,
  openSecrets,
  openStorage,
  type StorageFactory,
  type TargetInput,
} from '#deployments/target.ts';
import { connectorFactory } from '#connectivity/transports';
import { requestAuthorizer } from '#connectivity/auth/index.ts';
import { resolveProfile, type GlobalFlags } from './select.ts';
import { buildRegistryWithWorkspace, reloadSkills, skillFingerprint } from './registry.ts';
import { discoveryProbe } from './discovery.ts';

/**
 * Assembling a profile's runtime from its declared target.
 *
 * The same config can run in more than one place; a target names an adapter
 * set. Connections, providers, policy, and limits are declared once and apply
 * to every target — only the adapters differ, which is what lets M2 change
 * nothing at the application layer.
 */

export interface Runtime {
  readonly resolution: Resolution;
  readonly config: Config;
  readonly target: string;
  readonly state: RuntimeState;
  /** The durable log, for reading. Copies, if any, are write-only and not here. */
  readonly audit: AuditReader;
  readonly credentials: SecretStore;
  readonly storage: BlobStore;
  /** Where skills are kept — `data/<profile>/skills.d/` locally. */
  readonly skills: BlobStore;
  /** The vault's own store, so `lanes link vault` reaches the same bytes MCP does. */
  readonly vault: VaultStore;
  readonly registry: ProviderRegistry;
  /**
   * Re-read the skills into the registry when they have changed on the store.
   *
   * Cheap and idempotent — one `list()`, and a rebuild only when the listing
   * differs from the last one. The caller decides how often to ask.
   */
  refreshSkills(): Promise<void>;
  readonly dispatcher: Dispatcher;
  readonly authenticator: BearerAuthenticator;
  /** Same factory the dispatcher uses, exposed for commands that probe upstream. */
  connectorFor(providerId: string, connectionId: string): AnyConnector | undefined;
  /** A provider's manifest, so an omitted `credential_ref` can be derived from it. */
  manifestFor(providerId: string): ProviderManifest | undefined;
  close(): Promise<void>;
}

/**
 * Where this profile's skills live, in either target.
 *
 * Locally `data/<profile>/skills.d/`; deployed, the same key under the bucket
 * prefix. Going through the store rather than a filesystem path is what gives a
 * deployment skills at all — a path is baked into a container image at build
 * time and an object key is not, so before ADR-014 a deployed instance could
 * only ever serve the skills that existed when its image was built.
 *
 * **Per profile**, which reverses ADR-012 §1. Policy gating `skills.<name>`
 * was the whole isolation story while the bytes were shared, and it is a weak
 * one: it decides who may *run* a procedure, not who may read that it exists or
 * what it says. A skill written for work names work's accounts and work's
 * people. ADR-030.
 *
 * An explicit area, matching `openState` and `openAudit` — a profile that
 * declares its own `storage.path` moves its provider blobs, not the reserved
 * roots beside them.
 */
function skillStore(storage: StorageFactory, profile: string): BlobStore {
  return storage(layout.skills(profile));
}

/**
 * The vault's encrypted document, wherever this target keeps it.
 *
 * Defaults to `file`, so a profile written before ADR-014 needs no change and a
 * local run needs no vault configuration at all. `blob` exists because the file
 * adapter was unconditional before: a deployed instance wrote its vault to a
 * container filesystem, and every item in it was discarded by the next
 * revision without an error to say so.
 */
function openVault(
  input: TargetInput,
  storage: StorageFactory,
  credentials: SecretStore,
): VaultStore {
  const { declared, config, root } = input;
  const vault = declared.vault ?? { adapter: 'file' as const };

  switch (vault.adapter) {
    case 'file':
      return createFileVaultStore({
        path: workspacePath(root, vault.path ?? layout.vault(config.instance.profile)),
      });

    case 'secret':
      // The document is sealed under LANES_LINK_VAULT_KEY before it gets here,
      // so the credential store holds ciphertext it cannot read. Separate
      // document, separate key, separate environment variable — the backend
      // was never what kept the two stores apart. ADR-022.
      return createSecretVaultStore({
        store: credentials,
        ...(vault.ref !== undefined ? { ref: vault.ref } : {}),
      });

    case 'blob':
      return createBlobVaultStore({
        store: storage(),
        ...(vault.path !== undefined ? { key: vault.path } : {}),
      });
  }
}

export async function openRuntime(flags: GlobalFlags): Promise<Runtime> {
  const { resolution, config, target } = await resolveProfile(flags);
  const declared = config.targets[target];
  if (!declared) throw new ConfigError(`Target "${target}" is not declared`);

  const root = resolution.workspaceRoot;
  const adapters: TargetInput = { declared, config, root, target };

  // Credentials first: an S3 key pair is itself a credential reference, so the
  // credential store has to exist before the blob store that names it. State
  // and the log then ride that blob store rather than opening backends of
  // their own, which is why there is no migrate step here any more — there is
  // no schema left to migrate.
  const credentials = await openSecrets(adapters);
  const storageFor = await openStorage(adapters, credentials);
  const storage = storageFor();
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

  const skills = skillStore(storageFor, config.instance.profile);

  // The vault's own store, beside the credential store and never it: a separate
  // document, a separate key, and a separate environment variable
  // (`LANES_LINK_VAULT_KEY`). One master secret reused across purposes turns any
  // single compromise into a total one — `docs/detailed/security.md`, and the boundary
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
  const reachable = (): ReadonlyArray<{ key: string; provider: string; account: string }> =>
    config.connections
      .filter((connection) =>
        registry
          .capabilities()
          .some(
            ({ id }) =>
              id.startsWith(`${connection.provider}.`) &&
              allowedConnections(
                id,
                [`${connection.provider}.${connection.id}`],
                principal,
                policy,
              ).length > 0,
          ),
      )
      .map((connection) => ({
        key: `${connection.provider}.${connection.id}`,
        provider: connection.provider,
        account: connection.account,
      }));

  registry = await buildRegistryWithWorkspace(root, config.instance.profile, {
    skillStore: skills,
    onSkillsChanged: refreshSkills,
    vault: { store: vaultStore, items: await vaultStore.ids() },
    setup: {
      profile: config.instance.profile,
      target,
      profiles: await listProfiles(root),
      catalogue: PROVIDER_MANIFESTS,
      ownClients: Object.keys(config.oauth_apps),
      reachable,
    },
  });
  // Seeded from the build that just happened, so the first refresh compares
  // against what is registered rather than rebuilding once to find out.
  fingerprint = await skillFingerprint(skills);

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

    const cached = await state.kv.get('discovery', entry.manifest.id);
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
  const connectorFor = connectorFactory({ registry, credentials });
  let closed = false;

  const dispatcher = new Dispatcher({
    config,
    registry,
    connectorFor,
    authorizeRequest: requestAuthorizer(registry, credentials),
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
    state,
    audit,
    credentials,
    storage,
    skills,
    vault: vaultStore,
    registry,
    refreshSkills,
    dispatcher,
    authenticator: new BearerAuthenticator({
      profile: config.instance.profile,
      tokenRef: config.auth.token_ref,
      credentials,
    }),
    connectorFor,
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
