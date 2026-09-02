import {
  RESERVED_PROVIDER_IDS,
  type Capability,
  type DiscoveredCapability,
  type ProviderDefinition,
  type ProviderManifest,
} from '#connectivity';

/**
 * The provider registry.
 *
 * A provider is a **manifest**. Local providers additionally carry code, so the
 * registry holds one shape regardless of connectivity: every entry has a
 * manifest, and `definition` is present only for `local`.
 *
 * Capabilities come from two places and the difference is the point of this
 * milestone:
 *
 *   - **local** providers declare them in code (Zod input schemas)
 *   - **mcp / http** providers have them **discovered** — from an upstream
 *     server's `tools/list` or from an OpenAPI document — and cached in the
 *     database, so a stateless instance serves without a discovery round trip
 */

export interface RegisteredProvider {
  readonly manifest: ProviderManifest;
  /** Present only for `local` connectors. */
  readonly definition?: ProviderDefinition;
  /** Where this came from, so `provider list` can distinguish shipped from yours. */
  readonly origin: 'builtin' | 'workspace';
}

export interface RegisteredCapability {
  /** Fully qualified: `notion.search`. What policy rules and audit events name. */
  readonly id: string;
  readonly provider: string;
  /** For local providers. */
  readonly capability?: Capability;
  /** For discovered providers: re-derived at startup where the spec is committed, cached otherwise. */
  readonly discovered?: DiscoveredCapability;
}

export class ProviderRegistry {
  readonly #providers = new Map<string, RegisteredProvider>();
  /** provider id → discovered capabilities. See `cli/runtime/discovery.ts` for where they come from. */
  readonly #discovered = new Map<string, DiscoveredCapability[]>();
  readonly #allowReserved: boolean;
  #revision = 0;

  constructor(options: { allowReserved?: boolean } = {}) {
    this.#allowReserved = options.allowReserved ?? false;
  }

  /**
   * Bumped whenever the capability set changes.
   *
   * The endpoint memoises work derived from this registry — which wire names it
   * advertises, which ids exist — and those memos were computed once and could
   * not notice a `replace`. Reading a number is cheaper than recomputing them
   * per request and safer than assuming they never go stale.
   */
  get revision(): number {
    return this.#revision;
  }

  /**
   * `memory`, `skills`, and `vault` are refused until the owner layer ships.
   * Reserving them costs nothing today; reclaiming a namespace after providers
   * exist in the wild would silently change what a policy rule means.
   */
  register(entry: ProviderDefinition | ProviderManifest, origin: 'builtin' | 'workspace' = 'builtin'): void {
    const manifest = 'manifest' in entry ? entry.manifest : entry;
    const definition = 'manifest' in entry ? entry : undefined;

    if (this.#providers.has(manifest.id)) {
      throw new Error(`Provider "${manifest.id}" is already registered`);
    }

    if (!this.#allowReserved && RESERVED_PROVIDER_IDS.includes(manifest.id)) {
      throw new Error(
        `Provider id "${manifest.id}" is reserved for the owner layer (the lanes_ surfaces) and cannot be claimed.`,
      );
    }

    this.#providers.set(manifest.id, {
      manifest,
      ...(definition ? { definition } : {}),
      origin,
    });
    this.#revision++;
  }

  /**
   * Swap a provider already registered under this id, keeping its origin.
   *
   * Only `skills` uses this, and only because each skill is its own capability:
   * a skill written after the process started is invisible until the registry
   * holds it, and restarting an endpoint to pick up a file is the friction
   * ADR-014 set out to remove.
   *
   * **Not a general hot-reload facility.** Replacing a provider mid-flight
   * changes what policy is evaluated against between one call and the next, so
   * the only safe subjects are providers whose capabilities are pure data. The
   * vault deliberately does *not* use this — see ADR-012 §3, where an item
   * becoming readable only after a restart is the property, not the delay.
   */
  replace(entry: ProviderDefinition | ProviderManifest): void {
    const manifest = 'manifest' in entry ? entry.manifest : entry;
    const definition = 'manifest' in entry ? entry : undefined;

    const existing = this.#providers.get(manifest.id);
    if (!existing) {
      throw new Error(`Provider "${manifest.id}" is not registered, so there is nothing to replace`);
    }

    this.#providers.set(manifest.id, {
      manifest,
      ...(definition ? { definition } : {}),
      origin: existing.origin,
    });
    this.#revision++;
  }

  get(id: string): RegisteredProvider | undefined {
    return this.#providers.get(id);
  }

  manifest(id: string): ProviderManifest | undefined {
    return this.#providers.get(id)?.manifest;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): RegisteredProvider[] {
    return [...this.#providers.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  /**
   * Load discovered capabilities for a provider, from the database cache.
   *
   * Discovery itself happens in the CLI at connect and refresh time. The server
   * only ever reads what was cached, which is what keeps it stateless.
   */
  setDiscovered(providerId: string, capabilities: readonly DiscoveredCapability[]): void {
    this.#discovered.set(providerId, [...capabilities]);
  }

  discovered(providerId: string): readonly DiscoveredCapability[] {
    return this.#discovered.get(providerId) ?? [];
  }

  /**
   * Every capability across every registered provider, fully qualified.
   *
   * Hand-written and discovered are added together rather than either/or. A
   * `local` provider still has only the first and an `mcp` provider only the
   * second, but a remote provider may now carry a handful of authored
   * capabilities beside the ones its OpenAPI document describes — which is how a
   * mail API gets a send that assembles MIME here, since the generic HTTP
   * transport can only issue a JSON body and no document describes composing
   * one.
   *
   * Authored wins on a name collision. The overlap is the reason to author one at
   * all: the discovered version is the thing being replaced.
   */
  capabilities(): RegisteredCapability[] {
    return this.list().flatMap((entry): RegisteredCapability[] => {
      const providerId = entry.manifest.id;
      const authored = entry.definition?.capabilities ?? [];
      const names = new Set(authored.map((capability) => capability.name));

      return [
        ...authored.map((capability) => ({
          id: `${providerId}.${capability.name}`,
          provider: providerId,
          capability,
        })),
        ...this.discovered(providerId)
          .filter((capability) => !names.has(capability.name))
          .map((capability) => ({
            id: `${providerId}.${capability.name}`,
            provider: providerId,
            discovered: capability,
          })),
      ];
    });
  }

  findCapability(id: string): RegisteredCapability | undefined {
    return this.capabilities().find((entry) => entry.id === id);
  }

  /**
   * Which capability ids a bundle expands to.
   *
   * Local bundles name capabilities exactly. Discovered bundles match by glob,
   * because the names are not known when the manifest is written — and for
   * `http` connectors the bundle is decided by HTTP method, so the connector
   * assigns it during discovery rather than the manifest guessing.
   */
  expandBundle(providerId: string, bundleName: string): string[] {
    const entry = this.#providers.get(providerId);
    if (!entry) return [];

    const bundle = entry.manifest.bundles?.find((candidate) => candidate.name === bundleName);
    const discovered = this.discovered(providerId);

    if (discovered.length > 0) {
      return discovered
        .filter((capability) =>
          bundle
            ? capability.bundle === bundleName ||
              bundle.capabilities.some((pattern) => matchesGlob(pattern, capability.name))
            : capability.bundle === bundleName,
        )
        .map((capability) => `${providerId}.${capability.name}`);
    }

    return (bundle?.capabilities ?? []).map((name) => `${providerId}.${name}`);
  }

  defaultBundle(providerId: string): string | undefined {
    const manifest = this.#providers.get(providerId)?.manifest;
    return (manifest?.bundles?.find((bundle) => bundle.default) ?? manifest?.bundles?.[0])?.name;
  }
}

/** `*` matches any run of characters. Deliberately not a full glob dialect. */
export function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;

  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${expression}$`).test(value);
}
