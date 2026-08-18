/**
 * Where a profile's data lives, in one place.
 *
 * ```
 * ~/.lanes-link/
 * ├── lanes-link.yaml            which profiles exist, which is default
 * ├── profiles/<name>.yaml      each profile's declared config
 * ├── providers/*.yaml          the operator's own provider manifests
 * ├── skills/<name>/SKILL.md    procedures, shared by every profile
 * └── data/
 *     └── <profile>/            everything one profile owns
 *         ├── lanes-link.db      state, connections, audit
 *         ├── credentials.enc   system credentials, and its .key
 *         ├── vault.enc         the owner's items, its own key
 *         └── <provider>/<connection>/…   whatever that provider stores
 * ```
 *
 * **One profile, one directory.** Before this, `data/` held
 * `personal.db`, `personal.credentials.enc`, `personal.credentials.enc.key`,
 * `work.db`, and a `personal/` directory, all in one flat listing — three
 * profiles' worth of state interleaved, and no single thing to copy, back up, or
 * delete. Now `rm -r data/work` is exactly "remove the work profile's data" and
 * nothing else.
 *
 * **The blob root is the profile directory itself.** It used to be a `files/`
 * subdirectory, which bought nothing and cost a level: a memory entry landed at
 * `data/personal/files/memory/memory/entry/<id>.md`. The provider name and the
 * connection name are the isolation boundary (`scopeBlobStore` namespaces
 * `<provider>/<connection>`) and they are enough on their own, so an entry is
 * now `data/personal/memory/main/<id>.md`. There is no collision risk with the
 * files beside it: a provider id is `[a-z][a-z0-9_]*` and every reserved name
 * here contains a dot.
 *
 * Skills stay workspace-wide rather than per-profile, which is how they have
 * always loaded: every profile sees every skill, and policy still gates
 * `skills.<name>` per profile. A procedure is not private to a profile the way
 * its knowledge is.
 *
 * These are **defaults**. A profile that declares its own paths keeps them.
 *
 * There is no migration from the layout this replaced, deliberately: a
 * workspace is profiles, credentials, and whatever the owner has stored, and
 * re-creating one is `lanes link profile add` plus `lanes link connect` per account. Machinery
 * to move an old one would be more code than the thing it moves, and it would
 * have to keep working forever to be worth having.
 */

/** The directory under the workspace root that holds every profile's data. */
export const DATA_DIR = 'data';

/** Workspace-wide skills. Not per profile — see the note above. */
export const WORKSPACE_SKILL_DIR = 'skills';

/**
 * Everything one profile owns, relative to the workspace root.
 *
 * No leading `./`. It used to carry one, which `path.resolve` discards and an
 * object key does not: a bucket read `./data/personal/state.kv/x` as a
 * directory literally named `.`, so every deployed key landed one level away
 * from where the config said it did. The visible cost was that the conditioned
 * IAM binding `deployments/gcp/provision.ts` writes — which grants writes under
 * `objects/data/` — matched nothing, and the first revision 403'd on its boot
 * reconcile. A relative path is relative without being spelled that way.
 */
export function profileDir(profile: string): string {
  return `${DATA_DIR}/${profile}`;
}

export const layout = {
  /**
   * Connections, provider state, and cursors: one object per key.
   *
   * The dot is load-bearing, exactly as it is for `audit` below — a provider
   * is namespaced `<provider>/<connection>` under `blobs`, and a provider id
   * is `[a-z][a-z0-9_]*`, so a name carrying a dot is one no provider can be
   * scoped into.
   */
  state: (profile: string): string => `${profileDir(profile)}/state.kv`,
  /** System credentials — OAuth tokens, the profile token. Never reachable from MCP. */
  credentials: (profile: string): string => `${profileDir(profile)}/credentials.enc`,
  /** The owner's own items, under their own key. */
  vault: (profile: string): string => `${profileDir(profile)}/vault.enc`,
  /** The blob root every provider is namespaced under. */
  blobs: (profile: string): string => profileDir(profile),
  /**
   * The audit log: one object per event, under the profile's blob root.
   *
   * The dot is doing real work. A provider is namespaced to
   * `<provider>/<connection>` under `blobs` above, and a provider id is
   * `[a-z][a-z0-9_]*` — so a name carrying a dot is one no provider can be
   * scoped to. Without it, a provider called `audit` would be handed a store
   * rooted inside the log, which is a hole in ADR-007's wall rather than an
   * untidy filename.
   */
  audit: (profile: string): string => `${profileDir(profile)}/audit.log`,
} as const;
