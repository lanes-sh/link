import type { BearerAuthenticator } from '#auth';
import type { SecretStore } from '#secrets';
import type { AuditReader } from '#audit';
import type { RuntimeState } from '#stores/state';
import type { BlobStore } from '#stores/blobs';
import type { AnyConnector, ProviderManifest } from '#connectivity';
import type {
  Config,
  ConnectionConfig,
  Resolution,
  SelectedConnection,
  TargetConfig,
} from '#profile';
import type { ProviderRegistry } from '#registry';
import type { Dispatcher } from '#dispatch';
import type { VaultStore } from '#providers/owner.ts';
import type { KnowledgeStores } from '#deployments/knowledge.ts';

/**
 * What a command is handed once a profile has been opened.
 *
 * Its own file so `open.ts` stays inside the size budget, and because this is
 * the thing every command in the CLI is written against — a reader looking for
 * "what do I get" should not have to read the assembly to find it.
 */

export interface Runtime {
  readonly resolution: Resolution;
  readonly config: Config;
  readonly target: string;
  /**
   * The target's adapter set, from the workspace that declares it.
   *
   * Here because the config no longer carries it. Every caller that used to
   * reach `config.targets[target]` — for a `deploy` block, a storage adapter, a
   * knowledge repository — reads this instead, and reads it without following
   * the pointer a second time (ADR-052).
   */
  readonly declared: TargetConfig;
  /**
   * The accounts this profile selects, joined to the grants that govern them.
   *
   * The join is done once, here, because everything that asks — status, doctor,
   * reconcile, setup — wants the same answer and three implementations of it is
   * three chances to disagree (`profile/connections.ts`).
   */
  readonly connections: readonly SelectedConnection[];
  /** Every account the workspace holds, granted or not. `connection list` reads this. */
  readonly workspaceConnections: readonly ConnectionConfig[];
  /** Vendors this workspace registered a client of its own for (`oauth_apps`). */
  readonly ownClients: readonly string[];
  readonly state: RuntimeState;
  /** The durable log, for reading. Copies, if any, are write-only and not here. */
  readonly audit: AuditReader;
  readonly credentials: SecretStore;
  readonly storage: BlobStore;
  /**
   * Where this profile's skills are kept — `data/skills.d/<connection>/` locally.
   *
   * `undefined` when the profile grants no `skills` connection. That is a real
   * state rather than an empty one, and it is worth the optionality: the owner
   * layer arrives granted (ADR-050), so a profile without it was denied it on
   * purpose, and handing back an empty store would report "no skills" for a
   * profile that is not allowed to have any — the same answer for two different
   * facts.
   */
  readonly skills: BlobStore | undefined;
  /**
   * Present only when this target keeps memory and skills in a repository.
   *
   * Nothing on the dispatch path reads it: `storage` and `skills` above are
   * already pointed at the right bytes, which is the whole design. It is here
   * so `target show` and `doctor` can say where those bytes are without
   * re-reading the config, and so the migration can reach the repository it is
   * committing to.
   */
  readonly knowledge?: KnowledgeStores | undefined;
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
  /**
   * Same authorizer the dispatcher uses, for the same reason `connectorFor` is here.
   *
   * A command that probes upstream needs the credential on the request, and it
   * must not learn how to put it there — that is one switch on the resolved
   * shape (`connectivity/auth/authorize.ts`) and a second copy would be a
   * second answer. `settleIdentity` is the caller: it asks a provider whose
   * account was just authorised, over whatever method that provider declares.
   */
  authorizeRequest(providerId: string, connectionId: string, request: Request): Promise<Request>;
  /** A provider's manifest, so an omitted `credential_ref` can be derived from it. */
  manifestFor(providerId: string): ProviderManifest | undefined;
  close(): Promise<void>;
}

