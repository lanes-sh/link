import type { AnyConnector, DiscoveredCapability, ProviderManifest } from '#connectivity';
import { createHttpConnector } from '#connectivity/transports';
import type { ProviderRegistry } from '#registry';
import { DISCOVERY_NAMESPACE, type RuntimeState } from '#stores/state';

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

/**
 * How many discovery-cache entries are read at once.
 *
 * The same bound, and the same reasoning, as the memory provider's listing: on
 * a bucket each of these is an HTTPS request, and a workspace registers of the
 * order of a hundred providers whether or not the operator connected them. The
 * cap is what keeps a cold start from trading serial round trips for
 * rate-limited ones.
 */
const READ_CONCURRENCY = 16;

/**
 * Fill the registry in with what each provider can do, before anything serves.
 *
 * Discovered capabilities never come from a live call on the dispatch path —
 * that is what keeps the server stateless. But "not live" is not the same as
 * "cached", and conflating the two was a bug: `connect` was the only writer of
 * this cache, so an operator who upgraded without re-authorising kept whatever
 * their last consent screen happened to discover. Drive shipped nine operations
 * and served six; Gmail served a `drafts.create` this repository had deleted,
 * because the spec is read by the tests and the cache is read by the endpoint.
 *
 * So: derive it where deriving is free, and read the cache only where it is
 * not. An `http` provider's capabilities are a pure function of a document
 * committed here — reviewed in a diff, not fetched from a vendor — which is the
 * property that makes re-deriving safe as well as cheap.
 *
 * **The cache reads are concurrent, and that is what this costs on a cold
 * start.** The endpoint does not bind its port until every profile is open, and
 * open includes this — so one serial round trip per unconnected provider, of
 * which there are of the order of eighty, was the largest single term in the
 * time between a request arriving and the port answering. Most of them are
 * misses, for providers the operator has never connected.
 */
export async function primeDiscovery(
  registry: ProviderRegistry,
  state: RuntimeState,
): Promise<void> {
  // Offline first and one at a time, because deriving from a committed document
  // is CPU with no round trip in it and there is nothing to overlap.
  const uncached: string[] = [];

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

    uncached.push(entry.manifest.id);
  }

  const cached: (string | null)[] = [];

  for (let start = 0; start < uncached.length; start += READ_CONCURRENCY) {
    cached.push(
      ...(await Promise.all(
        uncached
          .slice(start, start + READ_CONCURRENCY)
          .map((id) => state.kv.get(DISCOVERY_NAMESPACE, id)),
      )),
    );
  }

  // Applied in list order rather than completion order. `setDiscovered` mutates
  // the registry, and a registry whose contents depend on which read returned
  // first is one that differs between boots of the same configuration.
  uncached.forEach((id, index) => {
    const raw = cached[index];
    if (!raw) return;

    try {
      registry.setDiscovered(id, JSON.parse(raw));
    } catch {
      // A corrupt cache entry means "not discovered yet", which `plan` reports
      // and `connect` fixes — never a reason to fail startup.
    }
  });
}
