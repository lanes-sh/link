import { bearerTokenAsStored } from '#connectivity/auth/index.ts';
import type { AnyConnector, DiscoveredCapability, ProviderManifest } from '#connectivity';
import { createMcpConnector } from '#connectivity/transports';
import type { RegisteredProvider } from '#registry';
import type { SecretStore } from '#secrets';
import { progress, style } from '../../output.ts';

/**
 * Step three of `connect`: ask the upstream what it exposes.
 *
 * A manifest never declares capabilities for a proxied server — the server is
 * the source of truth, and a declared list would go stale the moment the vendor
 * ships. So this is the one part of connecting that talks to the thing being
 * connected for a reason other than authentication.
 *
 * Its own file because the three cases have nothing to do with one another: an
 * MCP server is asked over a session, an HTTP provider is read from a
 * description on disk, and a local provider already knows. Interleaved with the
 * config writing around them, that was three shapes wearing one `if`.
 */

/**
 * What discovery is actually doing, per kind, so the wait is explained.
 *
 * They differ enough to be worth saying: reading a local OpenAPI file is
 * instant, while signing in to an IMAP server is a TLS handshake and a LOGIN
 * against a host that sometimes takes its time.
 */
const DISCOVERY_NOTE: Record<string, string> = {
  mcp: 'Discovering capabilities…',
  http: 'Reading the API description…',
};

export async function discoverCapabilities(input: {
  readonly entry: RegisteredProvider;
  readonly manifest: ProviderManifest;
  readonly connectionId: string;
  readonly credentials: SecretStore;
  readonly connectorFor: (providerId: string, connectionId: string) => AnyConnector | undefined;
  /** Called with what was found, so the caller can cache and register it. */
  readonly remember: (discovered: DiscoveredCapability[]) => Promise<void>;
}): Promise<DiscoveredCapability[]> {
  const { entry, manifest, connectionId, credentials } = input;

  if (manifest.connector.kind === 'local') return localCapabilities(entry, manifest);

  progress(style.dim(DISCOVERY_NOTE[manifest.connector.kind] ?? 'Discovering capabilities…'));

  // MCP is the one kind that does not use the runtime's connector here: it
  // wants the token exactly as just written, without the refresh machinery that
  // `bearerToken` wraps around it. Every other kind carries whatever credential
  // it needs from the factory.
  const connector =
    manifest.connector.kind === 'mcp'
      ? createMcpConnector({
          endpoint: manifest.connector.endpoint,
          ...(manifest.connector.headers ? { headers: manifest.connector.headers } : {}),
          accessToken: () => bearerTokenAsStored(manifest, connectionId, credentials),
        })
      : input.connectorFor(manifest.id, connectionId);

  if (!connector) return [];

  // Discovery takes the manifest and nothing else. What a provider exposes is a
  // property of the provider, not of an account — which is just as well,
  // because the connection being created does not exist in config until the
  // step after this one.
  const discovered = await connector.discover({ manifest });
  await input.remember(discovered);
  return discovered;
}

/**
 * Local capabilities carry their bundle from the manifest.
 *
 * Resources are included alongside tools: they need a policy grant too, and
 * leaving them out would register a resource nothing is allowed to read.
 */
function localCapabilities(
  entry: RegisteredProvider,
  manifest: ProviderManifest,
): DiscoveredCapability[] {
  if (!entry.definition) return [];

  const bundleOf = (name: string): string | undefined =>
    manifest.bundles?.find((candidate) => candidate.capabilities.includes(name))?.name;

  return entry.definition.capabilities.map((capability) => ({
    name: capability.name,
    description: capability.description,
    inputSchema: {},
    ...(bundleOf(capability.name) ? { bundle: bundleOf(capability.name)! } : {}),
  }));
}
