import type { BlobStore } from '#stores/blobs';
import type { ProviderDefinition } from '#connectivity';
import { ConfigError } from '#profile';
import { ProviderRegistry } from '#registry';
import { RESERVED_BY_GRAMMAR } from '../commands/connect/custom/spec.ts';
import { loadProfileProviders } from '#providers/custom/index.ts';
import { loadProfileSkills, type LoadedSkill } from '#providers/skills/store.ts';
import { exampleProvider } from '#providers/example/provider.ts';
import {
  createIdentityProvider,
  createMemoryVaultStore,
  createSetupProvider,
  createSkillsProvider,
  createVaultProvider,
  memoryProvider,
  type IdentityProviderOptions,
  type SetupProviderOptions,
  type VaultStore,
} from '#providers/owner.ts';
import { PROVIDERS, PROVIDER_MANIFESTS } from '#providers/index.ts';

/**
 * Which providers exist, and keeping the skills among them current.
 *
 * Separate from `./open.ts` because building a registry is synchronous and
 * needs no adapters: `lanes link deploy` reads manifests and never opens a database.
 */

/** What the owner layer needs from its store before it can be built. */
export interface OwnerLayerOptions {
  /** Skills already loaded. Each becomes an MCP prompt. */
  readonly skills?: readonly LoadedSkill[];
  /**
   * Where to load them from, and where authoring writes.
   *
   * Its presence is what gives the provider its `skills.manage.*` half: a
   * registry built without one — `lanes link deploy` reads manifests and nothing else —
   * gets the prompts and no way to author them, rather than four capabilities
   * that would fail.
   */
  readonly skillStore?: BlobStore;
  /** Called after a skill is written or removed, so the registry can catch up. */
  readonly onSkillsChanged?: () => Promise<void>;
  /**
   * The vault store, and the items already in it.
   *
   * Both are resolved by the caller because opening an encrypted file is
   * asynchronous and building a registry is not. The item list has to be known
   * *here*: each item is its own `vault.get.<id>` capability, which is what
   * makes per-item policy expressible without teaching the policy engine about
   * arguments (ADR-012 §3).
   */
  readonly vault?: {
    readonly store: VaultStore;
    readonly items: ReadonlyArray<{ id: string; description?: string }>;
  };
  /**
   * What the read-only setup surface describes.
   *
   * `reachable` is a function evaluated per call, and the caller supplies it
   * because filtering it is a policy decision: `#providers` may not import
   * `#policy`, and computing visibility anywhere but through
   * `allowedConnections` is how discovery and enforcement drift apart.
   *
   * Absent for a registry built to read manifests — `lanes link deploy` — which
   * then gets a surface describing the catalogue and no accounts, rather than
   * two capabilities that would report an empty profile as the truth.
   */
  readonly setup?: SetupProviderOptions;
  /**
   * Who the profile says its owner is.
   *
   * Absent for a registry built to read manifests, which has no config to read
   * it from. The provider still registers — it reports an empty declaration
   * rather than vanishing, so the difference between "nothing declared" and
   * "this build has no such surface" stays visible.
   */
  readonly identity?: IdentityProviderOptions;
}

/**
 * Built-in providers: the local reference, the owner layer, plus the manifests.
 *
 * Statically imported for now; the registry does not care where a manifest came
 * from, which is what lets workspace YAML register alongside these.
 *
 * `allowReserved` is what admits `memory`, `skills`, `vault`, `setup`, and
 * `identity`. The guard
 * stays rather than being retired: it exists so a *third-party* provider cannot
 * claim a namespace whose policy rules would then silently mean something else,
 * and that reason survives the owner layer shipping. Only this one construction
 * site opts in.
 */
export function buildRegistry(owner: OwnerLayerOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry({ allowReserved: true });

  registry.register(exampleProvider);
  registry.register(memoryProvider);
  registry.register(skillsProviderFor(owner));
  registry.register(
    createVaultProvider({
      // No store means no reads to register; `vault.put` still works, and the
      // items it writes become readable at the next start.
      store: owner.vault?.store ?? createMemoryVaultStore(),
      items: owner.vault?.items ?? [],
    }),
  );

  registry.register(
    createSetupProvider(
      owner.setup ?? { profile: '', target: '', catalogue: PROVIDER_MANIFESTS },
    ),
  );

  registry.register(createIdentityProvider(owner.identity ?? { profile: '' }));

  for (const manifest of PROVIDERS) registry.register(manifest);
  return registry;
}

/**
 * Built-ins plus whatever the operator has dropped into this profile.
 *
 * A manifest registering under a built-in id is refused rather than silently
 * overriding it — an operator shadowing `gmail` by accident would be very hard
 * to diagnose from the outside.
 *
 * The profile is a parameter rather than read from a config here because two of
 * the three callers do not have one: `deploy` walks every profile in turn, and
 * `profile remove` is holding the name of the one being deleted. Passing it
 * makes "which profile's manifests" a question the caller has already answered.
 */
export async function buildRegistryWithWorkspace(
  root: string,
  profile: string,
  owner: OwnerLayerOptions = {},
): Promise<ProviderRegistry> {
  const skills =
    owner.skills ?? (owner.skillStore ? await loadProfileSkills(owner.skillStore) : []);
  const registry = buildRegistry({ ...owner, skills });

  for (const { manifest, path } of await loadProfileProviders(root, profile)) {
    if (registry.has(manifest.id)) {
      throw new ConfigError(
        `${path}: provider "${manifest.id}" is already built in. Rename it, or remove the file to use the built-in.`,
      );
    }
    // An id the CLI's own grammar has taken. `connect custom` refuses to create
    // one, and this is the other half: a file written by hand — or before that
    // command existed — would otherwise register cleanly, be unreachable
    // forever, and say nothing about why.
    if ((RESERVED_BY_GRAMMAR as readonly string[]).includes(manifest.id)) {
      throw new ConfigError(
        `${path}: provider "${manifest.id}" cannot be reached — "${manifest.id}" is the second word ` +
          `of \`lanes link connect ${manifest.id}\`, which is the command that declares one. ` +
          'Rename it.',
      );
    }
    registry.register(manifest, 'workspace');
  }

  return registry;
}

function skillsProviderFor(owner: OwnerLayerOptions): ProviderDefinition {
  return createSkillsProvider({
    skills: owner.skills ?? [],
    ...(owner.skillStore ? { store: owner.skillStore } : {}),
    ...(owner.onSkillsChanged ? { onChange: owner.onSkillsChanged } : {}),
  });
}

/**
 * Re-read the skills and swap them into the registry, if anything changed.
 *
 * Each skill is its own capability, so both halves of ADR-014's promise need
 * this: a skill written over MCP has to appear without a restart, and so does
 * one written by `lanes link skills add` in another terminal while the endpoint runs.
 *
 * The listing is the change check as well as the source. `BlobMetadata` carries
 * size and mtime, so a fingerprint costs one `list()` and no reads — which
 * matters on S3, where the alternative is fetching every skill on every poll.
 *
 * Returns the fingerprint it settled on, so the caller can decide when to ask
 * again rather than this deciding for it.
 */
export async function reloadSkills(
  registry: ProviderRegistry,
  store: BlobStore,
  previous: string,
  onChange: () => Promise<void>,
): Promise<string> {
  const fingerprint = await skillFingerprint(store);
  if (fingerprint === previous) return previous;

  registry.replace(
    skillsProviderFor({
      skills: await loadProfileSkills(store),
      skillStore: store,
      onSkillsChanged: onChange,
    }),
  );
  return fingerprint;
}

/**
 * The skills a starting runtime should register, and their fingerprint.
 *
 * `tolerant` is for a skills store that is somewhere else — a repository, and
 * therefore a network dependency whose failures are ordinary rather than
 * exceptional: an expired token, a spent rate limit, no connectivity on a
 * train. Without it, one of those takes down `openRuntime` itself, and with it
 * every command in the CLI, **including the two that diagnose and undo the
 * arrangement** (`lanes link doctor` and `lanes link knowledge use local`). A
 * token expiring would brick the profile and hide the fix.
 *
 * So a store that cannot be read comes back empty and says so on the log,
 * rather than throwing. This is the same trade `Generation.refreshSkills`
 * already makes for the poll — the endpoint keeps serving what it has instead
 * of falling over — applied to the one read that had no such guard.
 *
 * **A malformed skill still throws, in either mode.** That is not a store
 * failure, it is a document the owner wrote and wants to hear about, and
 * swallowing it would leave one skill silently missing forever.
 */
export async function readSkillsForStart(
  store: BlobStore,
  tolerant: boolean,
  warn: (message: string) => void,
  /** `--profile x --target y`, so the two commands in the warning are pasteable. */
  selection = '',
): Promise<{ skills: LoadedSkill[]; fingerprint: string }> {
  try {
    return { skills: await loadProfileSkills(store), fingerprint: await skillFingerprint(store) };
  } catch (error) {
    if (!tolerant || error instanceof ConfigError) throw error;

    warn(
      `could not read this profile's skills: ${(error as Error).message}\n` +
        `  Nothing else is affected. Run \`lanes link doctor${selection}\` for what is wrong, ` +
        `or \`lanes link knowledge use local --migrate${selection}\` to bring them back onto ` +
        'this machine.',
    );
    // An empty fingerprint rather than one of nothing, so the next poll retries
    // instead of concluding the store is empty and staying that way.
    return { skills: [], fingerprint: '' };
  }
}

export async function skillFingerprint(store: BlobStore): Promise<string> {
  return (await store.list())
    .map((blob) => `${blob.key}:${blob.size}:${blob.modifiedAt.getTime()}`)
    .sort()
    .join('\n');
}
