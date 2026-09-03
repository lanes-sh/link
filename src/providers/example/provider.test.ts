import { describe, expect, test } from 'bun:test';
import { isResource, isTool, type ProviderContext, type ToolCapability } from '#connectivity';
import { exampleProvider } from './provider.ts';

/**
 * The example provider is the SDK reference, so these tests double as a
 * demonstration of how a provider is tested: build a context, call a handler,
 * assert on the result. No server, no policy layer, no transport.
 */

function contextFor(connectionKey: string, state = new Map<string, string>()): ProviderContext {
  return {
    connection: {
      id: connectionKey.split('.')[1] ?? 'a',
      key: connectionKey,
      displayName: 'Test',
      config: {},
    },
    profiles: ['personal'],
    state: {
      async get(key) {
        return state.get(key) ?? null;
      },
      async set(key, value) {
        state.set(key, value);
      },
      async delete(key) {
        state.delete(key);
      },
      async keys() {
        return [...state.keys()];
      },
      async getJson<T>(key: string) {
        const raw = state.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      },
      async setJson(key, value) {
        state.set(key, JSON.stringify(value));
      },
    },
    storage: {
      async put() {},
      async get() {
        return null;
      },
      async has() {
        return false;
      },
      async delete() {},
      async list() {
        return [];
      },
    },
    credentials: {
      async get() {
        return null;
      },
      async has() {
        return false;
      },
    },
    audit: { annotate() {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

function tool(name: string): ToolCapability {
  const found = exampleProvider.capabilities.find((c) => c.name === name);
  if (!found || !isTool(found)) throw new Error(`no tool named ${name}`);
  return found;
}

const textOf = (result: { content: ReadonlyArray<{ type: string } & Record<string, unknown>> }) =>
  result.content[0]?.['text'] as string;

describe('provider definition', () => {
  test('declares no auth, which is what makes it an owner provider', () => {
    // The same shape memory, skills, and vault take in M3 — no third-party
    // account, so `lanes link connect example` opens no browser.
    expect(exampleProvider.manifest.auth).toEqual({ kind: 'none' });
  });

  test('declares a default bundle', () => {
    const defaultBundle = exampleProvider.manifest.bundles?.find((bundle) => bundle.default);
    expect(defaultBundle?.name).toBe('read');
    // Read is the default; writing notes is opt-in.
    expect(defaultBundle?.capabilities).not.toContain('set_note');
  });

  test('every bundle references capabilities that exist', () => {
    const names = new Set(exampleProvider.capabilities.map((c) => c.name));
    for (const bundle of exampleProvider.manifest.bundles ?? []) {
      for (const capability of bundle.capabilities) {
        expect(names).toContain(capability);
      }
    }
  });

  test('no capability declares a connection argument', () => {
    // Core injects it and resolves it before a handler runs — ADR-001. A
    // provider declaring its own would shadow that and break routing.
    for (const capability of exampleProvider.capabilities) {
      if (!isTool(capability)) continue;
      const shape = (capability.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
      expect(Object.keys(shape ?? {})).not.toContain('connection');
    }
  });
});

describe('echo', () => {
  test('names the connection it was routed to', async () => {
    const result = await tool('echo').handler({ message: 'hello' }, contextFor('example.a'));
    expect(textOf(result)).toBe('[example.a] hello');
  });
});

describe('notes', () => {
  test('store, read, list, and delete', async () => {
    const state = new Map<string, string>();
    const context = contextFor('example.a', state);

    await tool('set_note').handler({ key: 'shopping', value: 'milk' }, context);
    expect(textOf(await tool('get_note').handler({ key: 'shopping' }, context))).toBe('milk');
    expect(textOf(await tool('list_notes').handler({}, context))).toBe('shopping');

    await tool('delete_note').handler({ key: 'shopping' }, context);
    const missing = await tool('get_note').handler({ key: 'shopping' }, context);
    expect(missing.isError).toBe(true);
  });

  test('a missing note is a tool error rather than a throw', async () => {
    const result = await tool('get_note').handler({ key: 'nope' }, contextFor('example.a'));

    // An agent can read and react to this; an exception would surface as a
    // transport failure instead.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No note "nope"');
  });

  test('listing an empty connection says so', async () => {
    expect(textOf(await tool('list_notes').handler({}, contextFor('example.b')))).toContain(
      'No notes on example.b',
    );
  });

  test('notes are per connection', async () => {
    const a = contextFor('example.a', new Map());
    const b = contextFor('example.b', new Map());

    await tool('set_note').handler({ key: 'n', value: 'from a' }, a);

    expect(textOf(await tool('get_note').handler({ key: 'n' }, a))).toBe('from a');
    expect((await tool('get_note').handler({ key: 'n' }, b)).isError).toBe(true);
  });
});

describe('redaction rules', () => {
  test('set_note records the key but never the value', () => {
    const redact = tool('set_note').redact!;
    const recorded = redact({ key: 'shopping', value: 'a private note' });

    expect(recorded['key']).toBe('shopping');
    expect(recorded['value']).toBe('<string:14>');
  });

  test('echo records its message, because the message is the whole payload', () => {
    expect(tool('echo').redact!({ message: 'hello' })['message']).toBe('hello');
  });
});

describe('the note resource', () => {
  const resource = exampleProvider.capabilities.find(
    (capability) => capability.name === 'note' && isResource(capability),
  );

  test('exists as a resource rather than a tool — ADR-006', () => {
    // A note is read-oriented context addressed by a stable identifier, which
    // is what resources are for. Making everything a tool is the easy default
    // and the wrong one.
    expect(resource).toBeDefined();
    expect(resource && isResource(resource)).toBe(true);
  });

  test('reads a stored note by URI', async () => {
    if (!resource || !isResource(resource)) throw new Error('missing resource');

    const state = new Map<string, string>();
    const context = contextFor('example.a', state);
    await tool('set_note').handler({ key: 'shopping', value: 'milk' }, context);

    const contents = await resource.read('example://note/shopping', { key: 'shopping' }, context);
    expect(contents).toMatchObject({ text: 'milk', mimeType: 'text/plain' });
  });

  test('lists stored notes as addressable URIs', async () => {
    if (!resource || !isResource(resource)) throw new Error('missing resource');

    const state = new Map<string, string>();
    const context = contextFor('example.a', state);
    await tool('set_note').handler({ key: 'one', value: '1' }, context);
    await tool('set_note').handler({ key: 'two', value: '2' }, context);

    expect(await resource.list?.(context)).toEqual([
      { uri: 'example://note/one', name: 'one' },
      { uri: 'example://note/two', name: 'two' },
    ]);
  });

  test('reading a note that does not exist throws rather than returning empty', async () => {
    if (!resource || !isResource(resource)) throw new Error('missing resource');

    await expect(
      resource.read('example://note/nope', { key: 'nope' }, contextFor('example.a')),
    ).rejects.toThrow(/No note "nope"/);
  });
});
