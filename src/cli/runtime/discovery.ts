import type { AnyConnector, DiscoveredCapability, ProviderManifest } from '#connectivity';
import { createHttpConnector } from '#connectivity/transports';

/**
 * What it costs to ask a provider what it can do.
 *
 * Discovery is not one thing. For an `http` connector it is a pure function of
 * an OpenAPI document committed to this repository — no token, no socket, and
 * measured at 15ms for all seven Google providers together. For `mcp` it is a
 * request. For `imap` and `dav` it is a TLS handshake and a login against a
 * server that throttles exactly that.
 *
 * Startup re-derives the free ones and `doctor` reports on the rest, and both
 * ask this module which is which. Two callers guessing separately at what a
 * probe costs is how they drift — which is the bug this file exists to fix, one
 * level up: `connect` was the only writer of the discovery cache, so a spec
 * change landed in the repository and never reached the endpoint.
 */

export type ProbeCost =
  /** Reads a committed document. Safe on the boot path. */
  | 'offline'
  /** One HTTP request to the upstream. */
  | 'network'
  /** Opens an authenticated session. Never on the boot path. */
  | 'session';

export interface DiscoveryProbe {
  readonly cost: ProbeCost;
  run(): Promise<readonly DiscoveredCapability[]>;
}

/**
 * An `openapi` that names a document we ship, rather than one we fetch.
 *
 * Load-bearing, and the reason this is a check rather than an assumption about
 * `kind === 'http'`: `providers/custom/template.ts` documents that a custom
 * provider may point `openapi` at a URL. Re-deriving that at startup would put
 * a network fetch on the boot path of every command, so those keep the cache.
 */
function isLocalDocument(openapi: string): boolean {
  return !/^https?:\/\//i.test(openapi);
}

/**
 * How to re-discover this provider, or `undefined` if it cannot be discovered.
 *
 * `connector` is only consulted for the kinds that need one — an `http`
 * provider is probed straight from its manifest, so it does not need a
 * connection to exist. That is what lets startup re-derive before any
 * connection is read, and what makes the probe work when a token has expired.
 */
export function discoveryProbe(
  manifest: ProviderManifest,
  connector?: AnyConnector | undefined,
): DiscoveryProbe | undefined {
  const declared = manifest.connector;

  // Authored capabilities are not discovered — they are the definition.
  if (declared.kind === 'local') return undefined;

  if (declared.kind === 'http' && isLocalDocument(declared.openapi)) {
    return {
      cost: 'offline',
      run: () =>
        createHttpConnector({
          baseUrl: declared.base_url,
          openapi: declared.openapi,
          ...(declared.operations?.include?.length
            ? { include: declared.operations.include }
            : {}),
          ...(declared.operations?.exclude?.length
            ? { exclude: declared.operations.exclude }
            : {}),
        }).discover({ manifest }),
    };
  }

  if (!connector) return undefined;

  const cost: ProbeCost = declared.kind === 'imap' || declared.kind === 'dav' ? 'session' : 'network';
  return { cost, run: () => connector.discover({ manifest }) };
}

/**
 * One capability set against another, by name.
 *
 * `changed` is the case ADR-017 said `plan` structurally could not report — "it
 * diffs capability names, and what changed here is a schema". A description or
 * an input schema moving is exactly what a hint or a re-vendor does, and an
 * operator who cannot see it has no way to know a restart is owed.
 */
export interface CapabilityDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function capabilityDiff(
  before: readonly DiscoveredCapability[],
  after: readonly DiscoveredCapability[],
): CapabilityDiff {
  const previous = new Map(before.map((capability) => [capability.name, capability]));
  const next = new Map(after.map((capability) => [capability.name, capability]));

  const added = [...next.keys()].filter((name) => !previous.has(name));
  const removed = [...previous.keys()].filter((name) => !next.has(name));
  const changed = [...next.keys()].filter((name) => {
    const was = previous.get(name);
    if (!was) return false;
    const is = next.get(name)!;
    return (
      was.description !== is.description ||
      JSON.stringify(was.inputSchema) !== JSON.stringify(is.inputSchema)
    );
  });

  return { added, removed, changed };
}

export function isEmptyDiff(diff: CapabilityDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
