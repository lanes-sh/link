/**
 * Where a workspace's data lives, in one place.
 *
 * ```
 * ~/.lanes-link/
 * ├── lanes-link.yaml           the workspaces this machine knows, and the default
 * ├── connections.yaml          every account authorised in this workspace
 * ├── profiles/<name>.yaml      which of them a profile selects, and who may use it
 * └── data/
 *     ├── state.kv/             state, connections, cursors
 *     ├── audit.log/            one object per event, one chain
 *     ├── credentials.enc       system credentials, and its .key
 *     ├── vault.d/<id>.enc      one sealed document per vault connection
 *     ├── skills.d/<id>/        procedures, one <name>/SKILL.md each
 *     ├── providers.d/          the operator's own provider manifests
 *     └── <provider>/<connection>/…   whatever that provider stores
 * ```
 *
 * **Nothing here takes a profile.** It used to take one for everything: a
 * profile owned a directory, and `rm -r data/work` was the whole answer to
 * "remove the work profile's data". A connection belongs to the workspace now
 * (ADR-057) and so do the stores behind the owner layer (ADR-059), so a profile
 * owns no bytes at all — it owns a selection, and the thing a selection points
 * at outlives it. `profile remove` prints what survives rather than letting the
 * difference go unnoticed.
 *
 * **The dot is load-bearing, and it is the only thing keeping these apart from
 * a provider.** The blob root is `data/` and a provider is namespaced
 * `<provider>/<connection>` under it; a provider id is `[a-z][a-z0-9_]*`, so a
 * name carrying a dot is one no provider can be scoped into. That is not
 * hypothetical for three of the five names below — `skills`, `vault` and
 * `audit` are all real provider ids, and without the dot each would be handed a
 * store rooted inside the thing it is meant to be walled off from, which is a
 * hole in ADR-007's wall rather than an untidy filename.
 *
 * `vault.d/<id>.enc` rather than `vault/<id>.enc` for exactly that reason. The
 * sealed document is not a blob the vault provider serves, and a `vault/`
 * prefix shared between the two would put the ciphertext inside the namespace
 * the provider is given.
 *
 * These are **defaults**. A workspace that declares its own paths keeps them.
 */

/** The directory under the workspace root that holds everything the workspace owns. */
export const DATA_DIR = 'data';

/**
 * No leading `./` on any of these.
 *
 * It used to carry one, which `path.resolve` discards and an object key does
 * not: a bucket read `./data/state.kv/x` as a directory literally named `.`, so
 * every deployed key landed one level away from where the config said it did.
 * The visible cost was that the conditioned IAM binding
 * `deployments/gcp/provision.ts` writes — which grants writes under
 * `objects/data/` — matched nothing, and the first revision 403'd on its boot
 * reconcile. A relative path is relative without being spelled that way.
 */
export const layout = {
  /** Connections, provider state, and cursors: one object per key. */
  state: (): string => `${DATA_DIR}/state.kv`,
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
  credentials: (): string => `${DATA_DIR}/credentials.enc`,
  /** Every vault connection's sealed document lives under here. */
  vaultRoot: (): string => `${DATA_DIR}/vault.d`,
  /** One sealed document per vault connection, each under its own key. */
  vault: (connection: string): string => `${DATA_DIR}/vault.d/${connection}.enc`,
  /**
   * Every skills connection's procedures live under here.
   *
   * The root is exported beside the per-connection path because `deploy` needs
   * to recognise the *area* without knowing which connections exist — and
   * `upload.ts` composes its allowlist back out of these rather than comparing
   * against literals, so a renamed directory moves the store and the thing that
   * sends it together, or neither.
   */
  skillsRoot: (): string => `${DATA_DIR}/skills.d`,
  /** One skills connection's procedures — `<name>.md` or `<name>/SKILL.md`, either layout. */
  skills: (connection: string): string => `${DATA_DIR}/skills.d/${connection}`,
  /**
   * The provider manifests this workspace declares.
   *
   * Workspace-level, where ADR-030 put them in the profile. A manifest names a
   * host, an OpenAPI document, and the credential refs that reach them — which
   * is to say it *defines a connection*, and connections do not live in a
   * profile any more. ADR-030's argument was about a procedure being as private
   * as the knowledge it operates on; that argument is answered by ADR-059's
   * instances, not by where a manifest sits.
   */
  providers: (): string => `${DATA_DIR}/providers.d`,
  /** The blob root every provider is namespaced under. */
  blobs: (): string => DATA_DIR,
  /**
   * The audit log: one object per event, one chain for the workspace.
   *
   * One chain rather than one per profile, because one endpoint serves them all
   * (ADR-009) and every event already records the profile it acted in. It is
   * also what lets `audit tail` filter where it used to select, and what gives
   * the dashboard a single log to read.
   */
  audit: (): string => `${DATA_DIR}/audit.log`,
} as const;
