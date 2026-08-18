import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '#registry';
import {
  defineProvider,
  defineProviderWithCapabilities,
  type AnyConnector,
  type ConnectorContext,
  type DiscoveredCapability,
  type ToolCapability,
  type ToolResult,
} from '#connectivity';
import { z } from 'zod';
import { createCompositeConnector } from './index.ts';

/**
 * A remote provider carrying a capability of its own.
 *
 * The property under test is that this changes nothing else: the discovered tools
 * still work, still come from the cache, and the authored one is simply answered
 * here instead of being sent upstream.
 */

const manifest = defineProvider({
  id: 'example_api',
  name: 'Example API',
  connector: { kind: 'http', base_url: 'https://api.example.com', openapi: '/dev/null' },
  auth: { kind: 'bearer', credential_ref: 'example/token' },
});

const authored: ToolCapability = {
  kind: 'tool',
  name: 'compose',
  description: 'Something the vendor document cannot describe.',
  inputSchema: z.object({ subject: z.string() }),
  async handler(input): Promise<ToolResult> {
    return { content: [{ type: 'text', text: `authored:${(input as { subject: string }).subject}` }] };
  },
};

const REMOTE_TOOLS: DiscoveredCapability[] = [
  { name: 'list_things', description: 'From the document.', inputSchema: {}, bundle: 'read' },
  { name: 'compose', description: 'The generated one.', inputSchema: {}, bundle: 'write' },
];

const fakeRemote = () => {
  const invoked: string[] = [];

  const remote: AnyConnector = {
    kind: 'http',
    async discover() {
      return REMOTE_TOOLS;
    },
    async invoke(capability): Promise<ToolResult> {
      invoked.push(capability.name);
      return { content: [{ type: 'text', text: `remote:${capability.name}` }] };
    },
    async identify() {
      return 'account@example.com';
    },
  };

  return { remote, invoked };
};

const CONTEXT = {
  manifest,
  provider: { audit: { annotate() {} } },
  authorize: async (request: Request) => request,
} as unknown as ConnectorContext;

const textOf = (result: unknown): string =>
  ((result as ToolResult).content[0] as { text: string }).text;

describe('the composite connector', () => {
  const definition = defineProviderWithCapabilities({ manifest, capabilities: [authored] });

  test('answers an authored capability itself', async () => {
    const { remote, invoked } = fakeRemote();
    const connector = createCompositeConnector({ definition, remote });

    const result = await connector.invoke(
      { name: 'compose', description: '', inputSchema: {} },
      { subject: 'Hi' },
      CONTEXT,
    );

    expect(textOf(result)).toBe('authored:Hi');
    // Never forwarded. An authored name exists precisely to replace the
    // generated one, so reaching upstream would defeat the point.
    expect(invoked).toEqual([]);
  });

  test('delegates everything else untouched', async () => {
    const { remote, invoked } = fakeRemote();
    const connector = createCompositeConnector({ definition, remote });

    const result = await connector.invoke(
      { name: 'list_things', description: '', inputSchema: {} },
      {},
      CONTEXT,
    );

    expect(textOf(result)).toBe('remote:list_things');
    expect(invoked).toEqual(['list_things']);
  });

  test('reports the remote kind, not a kind of its own', async () => {
    // `doctor`, `provider list` and the setup walkthrough all describe how the
    // account is reached. "composite" would answer a question nobody asked.
    const { remote } = fakeRemote();

    expect(createCompositeConnector({ definition, remote }).kind).toBe('http');
  });

  test('discovery is delegated, so authored names never enter the cache', async () => {
    // They are code. A cached row naming one would outlive a rename.
    const { remote } = fakeRemote();
    const connector = createCompositeConnector({ definition, remote });

    expect((await connector.discover({ manifest })).map((entry) => entry.name)).toEqual([
      'list_things',
      'compose',
    ]);
  });

  test('identify still comes from the remote, which holds the account', async () => {
    const { remote } = fakeRemote();
    const connector = createCompositeConnector({ definition, remote });

    expect(await connector.identify?.()).toBe('account@example.com');
  });
});

describe('what the registry lists', () => {
  test('authored and discovered capabilities are added together', async () => {
    const registry = new ProviderRegistry();
    registry.register(defineProviderWithCapabilities({ manifest, capabilities: [authored] }));
    registry.setDiscovered('example_api', [REMOTE_TOOLS[0]!]);

    expect(registry.capabilities().map((entry) => entry.id).sort()).toEqual([
      'example_api.compose',
      'example_api.list_things',
    ]);
  });

  test('an authored name wins the collision, since replacing is why it exists', async () => {
    const registry = new ProviderRegistry();
    registry.register(defineProviderWithCapabilities({ manifest, capabilities: [authored] }));
    registry.setDiscovered('example_api', REMOTE_TOOLS);

    const compose = registry.capabilities().filter((entry) => entry.id === 'example_api.compose');

    expect(compose).toHaveLength(1);
    expect(compose[0]!.capability?.description).toBe('Something the vendor document cannot describe.');
    expect(compose[0]!.discovered).toBeUndefined();
  });

  test('a manifest-only provider still lists only what was discovered', async () => {
    const registry = new ProviderRegistry();
    registry.register(manifest);
    registry.setDiscovered('example_api', REMOTE_TOOLS);

    const listed = registry.capabilities();

    expect(listed.map((entry) => entry.id)).toEqual([
      'example_api.list_things',
      'example_api.compose',
    ]);
    expect(listed.every((entry) => entry.discovered !== undefined)).toBe(true);
  });
});

describe('refusing the shapes that are not this', () => {
  test('a local provider is sent to defineLocalProvider instead', () => {
    // There is no remote half to compose with, so the composite would be a
    // wrapper around nothing.
    const local = defineProvider({ id: 'local_thing', name: 'Local', connector: { kind: 'local' } });

    expect(() => defineProviderWithCapabilities({ manifest: local, capabilities: [authored] })).toThrow(
      /defineLocalProvider/,
    );
  });

  test('authoring nothing is an ordinary manifest and says so', () => {
    expect(() => defineProviderWithCapabilities({ manifest, capabilities: [] })).toThrow(
      /register it directly/,
    );
  });

  test('the same capability twice is refused at import', () => {
    expect(() =>
      defineProviderWithCapabilities({ manifest, capabilities: [authored, authored] }),
    ).toThrow(/twice/);
  });
});
