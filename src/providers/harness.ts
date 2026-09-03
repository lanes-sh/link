import { createLocalConnector } from '#connectivity/transports';
import { buildProviderContext } from '#dispatch';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type {
  AnyConnector,
  CapabilityResult,
  ConnectorContext,
  ProviderContext,
  ProviderDefinition,
} from '#connectivity';

/**
 * One owner provider, wired the way the runtime wires it.
 *
 * Through the local connector rather than by calling handlers directly, because
 * the connector is what routes a resource read and a prompt render — the part
 * that did not exist before M4. The dispatcher and the MCP layer are covered end
 * to end in `apps/server/src/owner.test.ts`; this is the provider's own
 * behaviour.
 */
export interface ProviderHarness {
  readonly connector: AnyConnector;
  readonly context: ProviderContext;
  invoke(name: string, args?: Record<string, unknown>): Promise<CapabilityResult>;
  annotations(): Record<string, unknown>;
}

export function harnessFor(
  definition: ProviderDefinition,
  connectionId = 'owner',
): ProviderHarness {
  const annotations: Record<string, unknown> = {};

  const context = buildProviderContext({
    manifest: definition.manifest,
    definition,
    connection: { id: connectionId, provider: definition.manifest.id, account: 'Owner' },
    profiles: ['personal'],
    state: createMemoryState(),
    // Seeded deliberately: an owner provider must not be able to read any of
    // this, and the credential-boundary test says so by name.
    credentials: createMemoryCredentials({
      'gmail/main': 'refresh-token',
      'profile/token': 'llk_token',
    }),
    storage: createMemoryBlobStore(),
    audit: {
      annotate(detail) {
        Object.assign(annotations, detail);
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    // The runtime hands this to any provider that is not `local`, so a provider
    // authoring a capability against its own vendor's API has it here too.
    authorize: async (request) => request,
  });

  const connector = createLocalConnector(definition);

  const connectorContext: ConnectorContext = {
    manifest: definition.manifest,
    provider: context,
    authorize: async (request) => request,
  };

  return {
    connector,
    context,
    annotations: () => annotations,
    invoke: (name, args = {}) =>
      connector.invoke({ name, description: '', inputSchema: {} }, args, connectorContext),
  };
}

/** The resource links a tool result carries, unrouted as the provider wrote them. */
export function linksOf(result: CapabilityResult): string[] {
  if (!('content' in result)) return [];
  return result.content
    .filter((block): block is { type: 'resource_link'; uri: string } => block.type === 'resource_link')
    .map((block) => block.uri);
}

/** The text of a tool or resource result, joined — what a caller would read. */
export function textOf(result: CapabilityResult): string {
  if ('content' in result) {
    return result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  if ('contents' in result) return result.contents.map((entry) => entry.text).join('\n');
  if ('messages' in result) return result.messages.map((message) => message.text).join('\n');
  return result.resources.map((resource) => resource.uri).join('\n');
}
