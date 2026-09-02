/**
 * Where a workspace's files live, in one place.
 *
 * ```
 * ~/.lanes-link/
 * ├── workspaces.yaml           the workspaces this machine knows, and the default
 * ├── connections.yaml          every account authorised in this workspace
 * ├── credentials.enc           system credentials, and its .key
 * ├── providers.d/              the operator's own provider manifests
 * ├── audit.log/                one object per event, one chain
 * ├── state.kv/                 connections, discovery, the endpoint's own OAuth server
 * └── profiles/
 *     └── <profile>/            everything one profile is
 *         ├── profile.yaml      what it selects, and who may use it
 *         ├── state.kv/         cursors, and each provider's own keys
 *         ├── vault.d/<id>.enc  one sealed document per vault connection
 *         ├── skills.d/<id>/    procedures, one <name>/SKILL.md each
 *         └── <provider>/<connection>/…   whatever that provider stores
 * ```
 *
 * **A profile is one directory, and it owns its bytes.** Both halves reverse
 * something recent. ADR-059 put the owner layer's bytes beside the *connection*,
 * so a profile owned nothing and two profiles granting `memory.lan1` read one
 * note; ADR-066 makes the profile the container again, so they read two. And the
 * declaration used to sit at `profiles/<name>.yaml` while the data sat under
 * `data/<name>/` — the same structure in two places, for no reason anybody could
 * state (ADR-067).
 *
 * **There is no `data/` any more.** It meant "what a deployed revision writes,
 * as against the config it reads", which was worth a directory. `profile.yaml`
 * lives beside the bytes now, so that line has to be drawn inside it regardless
 * — and a directory holding everything names nothing. The IAM grant says which
 * prefixes are writable instead of saying which one is not.
 *
 * **The dot is load-bearing one level down, not here.** The root is not a
 * provider blob root; a *profile's* directory is. A provider is namespaced
 * `<provider>/<connection>` under it and a provider id is `[a-z][a-z0-9_]*`, so
 * a name carrying a dot is one no provider can be scoped into. That is not
 * hypothetical for three of the four names there — `skills`, `vault` and `state`
 * would each otherwise be handed a store rooted inside the thing it is meant to
 * be walled off from, which is a hole in ADR-007's wall rather than an untidy
 * filename. `profile.yaml` carries one for the same reason.
 *
 * `vault.d/<id>.enc` rather than `vault/<id>.enc` on the same grounds: the
 * sealed document is not a blob the vault provider serves, and a shared `vault/`
 * prefix would put the ciphertext inside the namespace the provider is given.
 *
 * `audit.log/` and `state.kv/` stay at the workspace. One endpoint serves every
 * profile and every event already records the profile it acted in, so one chain
 * is both sufficient and better evidence than several; and a connection's
 * reconcile status is a fact about an account, which a `connect` in one profile
 * must not have to repeat in the next. What follows the profile is what a
 * profile's use of an account produces — cursors, and the provider's own keys.
 *
 * These are **defaults**. A workspace that declares its own paths keeps them.
 */

/** The directory holding one subdirectory per profile. */
export const PROFILES_DIR = 'profiles';

/**
 * What a profile's declaration is called inside its own directory.
 *
 * Named here rather than spelled at the two call sites that need it — the path
 * builder below and `listProfiles`, which matches on it to tell a profile
 * directory from anything else under `profiles/`. Two spellings of one filename
 * is how a listing and a loader come to disagree about what exists.
 */
export const PROFILE_FILE = 'profile.yaml';

/**
 * No leading `./` on any of these.
 *
 * It used to carry one, which `path.resolve` discards and an object key does
 * not: a bucket read `./state.kv/x` as a directory literally named `.`, so
 * every deployed key landed one level away from where the config said it did.
 * The visible cost was that the conditioned IAM binding
 * `deployments/gcp/provision.ts` writes matched nothing, and the first revision
 * 403'd on its boot reconcile. A relative path is relative without being
 * spelled that way.
 */
export const layout = {
  /**
   * System credentials — OAuth refresh tokens, the CI token. Never reachable
   * from MCP.
   *
   * One store for the workspace, where there used to be one per profile. That
   * is what makes a `credential_ref` unique by construction and retires
   * `collidingRefs`, the deploy preflight that existed because two profiles
   * deployed into one project shared this namespace and the collision was
   * "silent until one profile is reading the other's account" (ADR-043,
   * ADR-057).
   */
  credentials: (): string => 'credentials.enc',
  /**
   * The provider manifests this workspace declares.
   *
   * Workspace-level, where ADR-030 put them in the profile. A manifest names a
   * host, an OpenAPI document, and the credential refs that reach them — which
   * is to say it *defines a connection*, and connections do not live in a
   * profile any more (ADR-057).
   */
  providers: (): string => 'providers.d',
  /**
   * The audit log: one object per event, one chain for the workspace.
   *
   * One chain rather than one per profile, because one endpoint serves them all
   * (ADR-009) and every event already records the profile it acted in. It is
   * also what lets `audit tail` filter where it used to select, and what gives
   * the dashboard a single log to read.
   */
  audit: (): string => 'audit.log',
  /**
   * What the workspace knows about its accounts, and about itself.
   *
   * Connection records and the discovery cache, because both are facts about an
   * account or a provider rather than about anybody's selection of it — a
   * `connect` run once must read as connected from every profile. And the
   * endpoint's own OAuth authorization-server state, which is not about a
   * connection at all: it is the clients that have signed in *to* this endpoint,
   * and there is one endpoint.
   */
  state: (): string => 'state.kv',

  /** Every profile's directory sits under here. */
  profilesRoot: (): string => PROFILES_DIR,
  /** Everything one profile is. Also the blob root its providers are scoped under. */
  profileDir: (profile: string): string => `${PROFILES_DIR}/${profile}`,
  /**
   * What this profile selects, and who may use it.
   *
   * Inside the profile's own directory, which is the whole of ADR-067 — but it
   * is therefore inside the tree a running endpoint writes, so the IAM condition
   * carves it back out. ADR-007 says a deployed revision never mutates its own
   * configuration, and that rule is older than where the file sits.
   */
  profileConfig: (profile: string): string => `${PROFILES_DIR}/${profile}/${PROFILE_FILE}`,
  /** Cursors, and each provider's own keys, for this profile's use of an account. */
  profileState: (profile: string): string => `${PROFILES_DIR}/${profile}/state.kv`,
  /** Every vault connection's sealed document, for this profile. */
  vaultRoot: (profile: string): string => `${PROFILES_DIR}/${profile}/vault.d`,
  /** One sealed document per vault connection, each under its own key. */
  vault: (profile: string, connection: string): string =>
    `${PROFILES_DIR}/${profile}/vault.d/${connection}.enc`,
  /**
   * The same document, keyed relative to the blob store.
   *
   * `blobs()` is already rooted at the profile's directory, so a blob adapter
   * handed the path above would write `profiles/p/profiles/p/vault.d/...`. Two
   * spellings of one location is exactly what this file exists to prevent, so
   * the second one lives here beside the first rather than being assembled at
   * the call site.
   */
  vaultKey: (connection: string): string => `vault.d/${connection}.enc`,
  /**
   * Every skills connection's procedures, for this profile.
   *
   * The root is exported beside the per-connection path because `deploy` needs
   * to recognise the *area* without knowing which connections exist — and
   * `upload.ts` composes its allowlist back out of these rather than comparing
   * against literals, so a renamed directory moves the store and the thing that
   * sends it together, or neither.
   */
  skillsRoot: (profile: string): string => `${PROFILES_DIR}/${profile}/skills.d`,
  /** One skills connection's procedures — `<name>.md` or `<name>/SKILL.md`, either layout. */
  skills: (profile: string, connection: string): string =>
    `${PROFILES_DIR}/${profile}/skills.d/${connection}`,
  /** The blob root this profile's providers are namespaced under. */
  blobs: (profile: string): string => `${PROFILES_DIR}/${profile}`,
} as const;

/**
 * `data/`, which no longer exists — kept for the migrations that address it.
 *
 * Contracts 1 through 3 put everything a profile owned under `data/<profile>/`,
 * and contract 4 moves it out (ADR-067). A migration reads the layout it is
 * migrating *from*, and that layout is frozen: asking `layout` above would
 * compare a contract-3 path against a contract-4 default and match nothing.
 * `migrate-plan.ts` already spells the contract-1 defaults out for the same
 * reason. Nothing outside a migration should import this.
 */
export const LEGACY_DATA_DIR = 'data';
