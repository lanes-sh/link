import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  defineLocalProvider,
  isPromptResult,
  isResourceListResult,
  isResourceResult,
  isToolResult,
  type ConnectorContext,
  type ProviderContext,
} from '#connectivity';
import { createLocalConnector, extractParams } from './index.ts';

/**
 * The local connector is the only one that carries anything but tools.
 *
 * Until M4 it filtered `discover()` to `isTool` and threw `"is not a tool"` in
 * `invoke()`, so the resource path registered in `packages/mcp` dispatched into
 * a wall — `example://note/{key}` had been declared since M1 and was unreadable
 * the whole time, with no test to say so. These are that test.
 */

const provider = defineLocalProvider({
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: 'one of each capability kind',
  configSchema: z.object({}),
  connectionSchema: z.object({}),

  capabilities: [
    {
      kind: 'tool',
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({ message: z.string() }),
      async handler({ message }) {
        return { content: [{ type: 'text', text: message }] };
      },
    },
    {
      kind: 'resource',
      name: 'doc',
      description: 'a document',
      uriTemplate: 'sample://doc/{slug}',
      async list() {
        return [{ uri: 'sample://doc/one', name: 'One' }];
      },
      async read(uri, params) {
        return { uri, text: `slug=${params['slug'] ?? '<none>'}` };
      },
    },
    {
      kind: 'resource',
      name: 'unbounded',
      description: 'a resource space too large to enumerate',
      uriTemplate: 'sample://any/{id}',
      async read(uri) {
        return { uri, text: 'x' };
      },
    },
    {
      kind: 'prompt',
      name: 'procedure',
      description: 'a reusable procedure',
      arguments: [{ name: 'subject', description: 'what about', required: true }],
      async render(args) {
        return { messages: [{ role: 'user', text: `About ${args['subject']}` }] };
      },
    },
  ],
});

const connector = createLocalConnector(provider);

const context = {
  manifest: provider.manifest,
  provider: {} as ProviderContext,
  authorize: async (request: Request) => request,
} satisfies ConnectorContext;

function target(name: string) {
  return { name, description: '', inputSchema: {} };
}

describe('discovery reports every kind', () => {
  test('resources and prompts are no longer dropped', async () => {
    const discovered = await connector.discover({ manifest: provider.manifest });

    expect(discovered.map((capability) => capability.name).sort()).toEqual([
      'doc',
      'echo',
      'procedure',
      'unbounded',
    ]);
  });

  test('only a tool carries a JSON Schema, because only a tool has one', async () => {
    const discovered = await connector.discover({ manifest: provider.manifest });
    const byName = new Map(discovered.map((capability) => [capability.name, capability]));

    expect(byName.get('echo')?.inputSchema['type']).toBe('object');
    expect(byName.get('doc')?.inputSchema).toEqual({});
  });
});

describe('invoking each kind', () => {
  test('a tool validates its arguments and returns tool content', async () => {
    const result = await connector.invoke(target('echo'), { message: 'hi' }, context);

    expect(isToolResult(result) && result.content[0]).toEqual({ type: 'text', text: 'hi' });
    await expect(connector.invoke(target('echo'), { message: 7 }, context)).rejects.toThrow(
      /Invalid arguments/,
    );
  });

  test('a uri argument reads the resource', async () => {
    const result = await connector.invoke(target('doc'), { uri: 'sample://doc/hello' }, context);

    expect(isResourceResult(result)).toBe(true);
    expect(isResourceResult(result) && result.contents[0]?.text).toBe('slug=hello');
  });

  test('no uri argument enumerates it', async () => {
    const result = await connector.invoke(target('doc'), {}, context);

    expect(isResourceListResult(result) && result.resources).toEqual([
      { uri: 'sample://doc/one', name: 'One' },
    ]);
  });

  test('a resource that declines to enumerate says so', async () => {
    await expect(connector.invoke(target('unbounded'), {}, context)).rejects.toThrow(
      /does not enumerate/,
    );
  });

  test('a prompt renders its messages', async () => {
    const result = await connector.invoke(target('procedure'), { subject: 'X' }, context);

    expect(isPromptResult(result) && result.messages).toEqual([{ role: 'user', text: 'About X' }]);
  });

  test('a required prompt argument is enforced', async () => {
    await expect(connector.invoke(target('procedure'), {}, context)).rejects.toThrow(
      /missing subject/,
    );
  });

  test('an unknown capability is refused by name', async () => {
    await expect(connector.invoke(target('nope'), {}, context)).rejects.toThrow(
      /sample.nope is not a capability/,
    );
  });
});

describe('recovering a resource template\u2019s own variables', () => {
  test('from a URI core has already routed', () => {
    // Core prepends `/{profile}/{connection}` after the authority, so the
    // provider's own segments are the trailing ones — matched from the right.
    expect(extractParams('sample://doc/{slug}', 'sample://doc/personal/owner/hello')).toEqual({
      slug: 'hello',
    });
  });

  test('from an unrouted URI too', () => {
    expect(extractParams('sample://doc/{slug}', 'sample://doc/hello')).toEqual({ slug: 'hello' });
  });

  test('several variables keep their order', () => {
    expect(extractParams('m://x/{a}/{b}', 'm://x/personal/owner/one/two')).toEqual({
      a: 'one',
      b: 'two',
    });
  });

  test('a template with no variables yields none', () => {
    expect(extractParams('m://fixed', 'm://fixed/personal/owner')).toEqual({});
  });
});
