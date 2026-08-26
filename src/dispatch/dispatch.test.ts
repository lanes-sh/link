import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ownerPrincipal } from '#auth';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { createBlobAuditStore } from '#deployments/adapters/audit-blob.ts';
import { RateLimiter } from '#policy';
import { createLocalConnector } from '#connectivity/transports';
import {
  defineLocalProvider,
  isToolResult,
  keepKeys,
  type AnyConnector,
  type ProviderContext,
} from '#connectivity';
import { parseConfig } from '#profile';
import { createConsoleLogger } from './context.ts';
import { Dispatcher, type DispatchOutcome } from './dispatch.ts';
import { toPolicyDocument } from '#registry';
import { ProviderRegistry } from '#registry';

/**
 * A provider defined here rather than importing the real example provider:
 * core must not depend on any particular provider, and these tests are about
 * the dispatch path rather than about what `example` does.
 */
let handlerCalls: Array<{ connection: string; args: unknown }> = [];

/**
 * The first content block of a successful tool call.
 *
 * Narrowing is needed now that dispatch can return a resource, a resource
 * listing, or a prompt — the same one path serves all four, which is what makes
 * a resource read policy-checked and audited like everything else.
 */
function firstBlock(outcome: DispatchOutcome): unknown {
  if (!outcome.ok || !isToolResult(outcome.result)) return undefined;
  return outcome.result.content[0];
}

const testProvider = defineLocalProvider({
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  description: 'test provider',
  configSchema: z.object({}),
  connectionSchema: z.object({}),
  capabilities: [
    {
      kind: 'tool',
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({ message: z.string().min(1) }),
      redact: keepKeys('message'),
      async handler({ message }, context: ProviderContext) {
        handlerCalls.push({ connection: context.connection.key, args: { message } });
        return { content: [{ type: 'text', text: message }] };
      },
    },
    {
      kind: 'tool',
      name: 'set_note',
      description: 'store a note',
      inputSchema: z.object({ key: z.string(), value: z.string() }),
      redact: keepKeys('key'), // value deliberately withheld
      async handler({ key, value }, context) {
        await context.state.set(key, value);
        context.audit.annotate({ bytes: value.length });
        return { content: [{ type: 'text', text: 'stored' }] };
      },
    },
    {
      kind: 'tool',
      name: 'get_note',
      description: 'read a note',
      inputSchema: z.object({ key: z.string() }),
      async handler({ key }, context) {
        const value = await context.state.get(key);
        return { content: [{ type: 'text', text: value ?? '<none>' }] };
      },
    },
    {
      kind: 'tool',
      name: 'boom',
      description: 'always throws',
      inputSchema: z.object({}),
      async handler() {
        throw new Error('provider exploded');
      },
    },
    {
      // Exists to be denied. The interesting assertion about a deny is that the
      // handler never runs, which needs a handler that would notice.
      kind: 'tool',
      name: 'purge',
      description: 'destructive',
      inputSchema: z.object({}),
      async handler(_args, context) {
        handlerCalls.push({ connection: context.connection.key, args: {} });
        return { content: [{ type: 'text', text: 'purged' }] };
      },
    },
  ],
});

const CONFIG = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage: { adapter: filesystem, path: ./data/files }
limits:
  requests_per_minute: 100
  upstream_calls_per_minute: 100
connections:
  - id: a
    provider: example
    account: A
  - id: b
    provider: example
    account: B
  - id: c
    provider: example
    account: C
policy:
  allow:
    - "example.*"
  deny:
    - "example.purge"
`).config;

const PRINCIPAL = ownerPrincipal('personal');
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function harness(overrides: { limits?: { profile: number; connection: number } } = {}) {
  const state = createMemoryState();
  const audit = createBlobAuditStore({ storage: createMemoryBlobStore() });
  const registry = new ProviderRegistry();
  registry.register(testProvider);

  const config = overrides.limits
    ? {
        ...CONFIG,
        limits: {
          requests_per_minute: overrides.limits.profile,
          upstream_calls_per_minute: overrides.limits.connection,
        },
      }
    : CONFIG;

  const dispatcher = new Dispatcher({
    config,
    registry,
    connectorFor: (providerId): AnyConnector | undefined => {
      const entry = registry.get(providerId);
      return entry?.definition ? createLocalConnector(entry.definition) : undefined;
    },
    policy: toPolicyDocument(CONFIG),
    state,
    audit,
    credentials: createMemoryCredentials(),
    storage: createMemoryBlobStore(),
    limiter: new RateLimiter(),
    log: silent,
  });

  return { dispatcher, state, audit, registry };
}

const call = (capabilityId: string, connectionKey: string, args: Record<string, unknown> = {}) => ({
  principal: PRINCIPAL,
  capabilityId,
  connectionKey,
  arguments: args,
});

beforeEach(() => {
  handlerCalls = [];
});

describe('authorized invocation', () => {
  test('reaches the provider and returns its result', async () => {
    const { dispatcher } = harness();
    const outcome = await dispatcher.invoke(call('example.echo', 'example.a', { message: 'hi' }));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(firstBlock(outcome)).toEqual({ type: 'text', text: 'hi' });
    expect(handlerCalls).toEqual([{ connection: 'example.a', args: { message: 'hi' } }]);
  });
});

describe('policy is enforced before the provider is reached', () => {
  test('a denied capability never invokes the handler', async () => {
    const { dispatcher } = harness();
    const outcome = await dispatcher.invoke(call('example.purge', 'example.b'));

    expect(outcome.ok).toBe(false);
    // The important assertion: provider code did not run at all, so
    // authorization is never something a provider could get wrong.
    expect(handlerCalls).toEqual([]);
  });

  test('an explicit deny beats the wildcard allow', async () => {
    const { dispatcher } = harness();
    const outcome = await dispatcher.invoke(call('example.purge', 'example.a'));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.authorization).toBe('denied_by_policy');
    expect(handlerCalls).toEqual([]);
  });

  test('every account of a provider is governed alike', async () => {
    // Rules name capabilities, not accounts. Two Gmail addresses in one profile
    // get the same grants by construction; separating them means a second
    // profile, which shares no state, credential store, or URL.
    const { dispatcher } = harness();

    for (const connection of ['example.a', 'example.b', 'example.c']) {
      expect((await dispatcher.invoke(call('example.echo', connection, { message: 'x' }))).ok).toBe(
        true,
      );
      expect((await dispatcher.invoke(call('example.purge', connection))).ok).toBe(false);
    }
  });

  test('an unknown capability is refused the same way a denied one is', async () => {
    const { dispatcher } = harness();

    const unknown = await dispatcher.invoke(call('example.nonexistent', 'example.a'));
    const ungranted = await dispatcher.invoke(call('notion.search', 'example.a'));

    // Probing must not distinguish "does not exist" from "not permitted", or
    // the error message becomes a capability enumeration oracle.
    expect(unknown.ok).toBe(false);
    expect(ungranted.ok).toBe(false);
    if (!unknown.ok && !ungranted.ok) {
      expect(unknown.authorization).toBe(ungranted.authorization);
      // Identical but for the name the caller already supplied. Echoing that
      // back reveals nothing; differing wording would.
      expect(unknown.message.replace('example.nonexistent', 'X')).toBe(
        ungranted.message.replace('notion.search', 'X'),
      );
    }
  });

  test('an unknown connection is refused', async () => {
    const { dispatcher } = harness();
    expect((await dispatcher.invoke(call('example.echo', 'example.nope', { message: 'x' }))).ok).toBe(
      false,
    );
  });
});

describe('connection isolation', () => {
  test('state written through one connection is invisible from another', async () => {
    const { dispatcher } = harness();

    await dispatcher.invoke(call('example.set_note', 'example.a', { key: 'n', value: 'from a' }));

    const fromA = await dispatcher.invoke(call('example.get_note', 'example.a', { key: 'n' }));
    const fromB = await dispatcher.invoke(call('example.get_note', 'example.b', { key: 'n' }));

    expect(firstBlock(fromA)).toEqual({ type: 'text', text: 'from a' });
    expect(firstBlock(fromB)).toEqual({ type: 'text', text: '<none>' });
  });
});

describe('audit records every invocation', () => {
  test('an allowed call is recorded', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.invoke(call('example.echo', 'example.a', { message: 'hi' }));

    const [event] = await audit.tail();
    expect(event).toMatchObject({
      profile: 'personal',
      principal: 'personal:owner',
      provider: 'example',
      connection: 'example.a',
      capability: 'example.echo',
      authorization: 'allowed',
      status: 'ok',
    });
  });

  test('a denial is recorded, which is the half worth having', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.invoke(call('example.purge', 'example.b'));

    const [event] = await audit.tail();
    expect(event).toMatchObject({
      capability: 'example.purge',
      connection: 'example.b',
      authorization: 'denied_by_policy',
      status: 'not_invoked',
    });
  });

  test('a provider that throws is recorded as an error, not lost', async () => {
    const { dispatcher, audit } = harness();

    // example.c is the one connection where boom is actually permitted, so
    // this reaches the handler and the handler throws.
    const outcome = await dispatcher.invoke(call('example.boom', 'example.c'));
    expect(outcome.ok).toBe(false);

    const [event] = await audit.tail();
    expect(event).toMatchObject({
      capability: 'example.boom',
      authorization: 'allowed', // it was permitted; the provider is what failed
      status: 'error',
      error: { kind: 'provider_error', message: 'provider exploded' },
    });
  });

  test('exactly one event per invocation', async () => {
    const { dispatcher, audit } = harness();

    await dispatcher.invoke(call('example.echo', 'example.a', { message: 'one' }));
    await dispatcher.invoke(call('example.echo', 'example.a', { message: 'two' }));
    await dispatcher.invoke(call('example.set_note', 'example.b', { key: 'k', value: 'v' }));

    expect(await audit.tail()).toHaveLength(3);
  });

  test('records the client label without ever consulting it for authorization', async () => {
    const { dispatcher, audit } = harness();

    const denied = await dispatcher.invoke({
      ...call('example.purge', 'example.b'),
      clientLabel: 'claude-code',
    });

    // The label is recorded for observability; it changed nothing about the
    // decision, which stayed a denial.
    expect(denied.ok).toBe(false);
    expect((await audit.tail())[0]?.clientLabel).toBe('claude-code');
  });

  test('carries provider annotations', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.invoke(call('example.set_note', 'example.a', { key: 'k', value: 'hello' }));

    const [event] = await audit.tail();
    expect(event?.arguments).toMatchObject({ _annotations: { bytes: 5 } });
  });
});

describe('audit redaction', () => {
  test('withholds values a provider did not opt into recording', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.invoke(
      call('example.set_note', 'example.a', { key: 'shopping', value: 'a private note' }),
    );

    const [event] = await audit.tail();
    expect(event?.arguments['key']).toBe('shopping');
    expect(event?.arguments['value']).toBe('<string:14>');
    expect(JSON.stringify(event?.arguments)).not.toContain('a private note');
  });

  test('applies the provider rule to denials too', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.invoke(
      call('example.set_note', 'example.b', { key: 'k', value: 'still private' }),
    );

    const [event] = await audit.tail();
    expect(JSON.stringify(event?.arguments)).not.toContain('still private');
  });

  test('defaults to withholding everything when a provider declares no rule', async () => {
    const { dispatcher, audit } = harness();
    await dispatcher.invoke(call('example.get_note', 'example.a', { key: 'sensitive-key' }));

    const [event] = await audit.tail();
    expect(event?.arguments['key']).toBe('<string:13>');
  });
});

describe('rate limits', () => {
  test('refuses once the per-profile budget is spent, and records the denial', async () => {
    const { dispatcher, audit } = harness({ limits: { profile: 2, connection: 100 } });

    expect((await dispatcher.invoke(call('example.echo', 'example.a', { message: '1' }))).ok).toBe(true);
    expect((await dispatcher.invoke(call('example.echo', 'example.a', { message: '2' }))).ok).toBe(true);

    const third = await dispatcher.invoke(call('example.echo', 'example.a', { message: '3' }));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.message).toMatch(/Rate limit exceeded/);

    expect((await audit.tail()).at(-1)?.authorization).toBe('denied_rate_limited');
  });

  test('the per-connection budget protects a vendor quota independently', async () => {
    const { dispatcher } = harness({ limits: { profile: 100, connection: 1 } });

    expect((await dispatcher.invoke(call('example.echo', 'example.a', { message: '1' }))).ok).toBe(true);
    expect((await dispatcher.invoke(call('example.echo', 'example.a', { message: '2' }))).ok).toBe(false);
    // A different connection still has its own budget.
    expect((await dispatcher.invoke(call('example.get_note', 'example.b', { key: 'k' }))).ok).toBe(true);
  });
});

describe('connection status', () => {
  test('an unauthorized connection says what fixes it, without pretending to be a command', async () => {
    const { dispatcher, state } = harness();
    await state.connections.upsert({
      provider: 'example',
      id: 'a',
      displayName: 'A',
      status: 'unauthorized',
    });

    const outcome = await dispatcher.invoke(call('example.echo', 'example.a', { message: 'x' }));
    expect(outcome.ok).toBe(false);
    // Named, not pasteable. This reaches an agent over MCP, and a `lanes link
    // connect` here would be missing the two flags that decide which store it
    // writes into — the dispatcher holds a config but never a target. A
    // half-command an agent runs is worse than a sentence it reports.
    if (!outcome.ok) {
      expect(outcome.message).toContain('example.a');
      expect(outcome.message).not.toContain('lanes link');
    }
    expect(handlerCalls).toEqual([]);
  });

  test('a disabled connection is refused', async () => {
    const { dispatcher, state } = harness();
    await state.connections.upsert({
      provider: 'example',
      id: 'a',
      displayName: 'A',
      status: 'disabled',
    });

    expect((await dispatcher.invoke(call('example.echo', 'example.a', { message: 'x' }))).ok).toBe(false);
  });
});

describe('argument validation', () => {
  test('rejects arguments the provider schema refuses, without invoking it', async () => {
    const { dispatcher } = harness();
    const outcome = await dispatcher.invoke(call('example.echo', 'example.a', { message: '' }));

    expect(outcome.ok).toBe(false);
    expect(handlerCalls).toEqual([]);
  });
});

describe('provider failure', () => {
  test('a throwing provider becomes an outcome rather than propagating', async () => {
    const { dispatcher } = harness();

    // The dispatcher must not let a provider's exception escape into the
    // transport, where it would surface as a dead connection rather than a
    // tool error the agent can react to.
    const outcome = await dispatcher.invoke(call('example.boom', 'example.c'));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('provider exploded');
  });

  test('a later call still works after one provider throws', async () => {
    const { dispatcher, audit } = harness();

    await dispatcher.invoke(call('example.boom', 'example.c'));
    const after = await dispatcher.invoke(call('example.echo', 'example.a', { message: 'still up' }));

    expect(after.ok).toBe(true);
    expect(await audit.tail()).toHaveLength(2);
  });
});

describe('registry reservations', () => {
  test('refuses to register a provider claiming an owner-layer namespace', () => {
    const registry = new ProviderRegistry();
    for (const id of ['memory', 'skills', 'vault']) {
      const squatter = defineLocalProvider({
        id,
        name: id,
        version: '1.0.0',
        description: 'squatter',
        configSchema: z.object({}),
        connectionSchema: z.object({}),
        capabilities: [],
      });
      expect(() => registry.register(squatter)).toThrow(/reserved for the owner layer/);
    }
  });

  test('allows them once the owner layer is what is registering', () => {
    const registry = new ProviderRegistry({ allowReserved: true });
    expect(() =>
      registry.register(
        defineLocalProvider({
          id: 'memory',
          name: 'Memory',
          version: '1.0.0',
          description: 'owner layer',
          configSchema: z.object({}),
          connectionSchema: z.object({}),
          capabilities: [],
        }),
      ),
    ).not.toThrow();
  });

  test('refuses a duplicate registration', () => {
    const registry = new ProviderRegistry();
    registry.register(testProvider);
    expect(() => registry.register(testProvider)).toThrow(/already registered/);
  });
});

describe('logging', () => {
  test('writes to stderr, so it cannot corrupt CLI output on stdout', () => {
    // stdout carries printed tokens and config diffs. A log line interleaved
    // into `lanes link outputs` would corrupt a token someone is about to paste.
    const written: string[] = [];
    const originalErr = process.stderr.write;
    const originalOut = process.stdout.write;
    let stdoutWrites = 0;

    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = (() => {
      stdoutWrites++;
      return true;
    }) as typeof process.stdout.write;

    try {
      createConsoleLogger('info').warn('careful', { connection: 'example.a' });
    } finally {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    }

    expect(stdoutWrites).toBe(0);
    expect(written.join('')).toContain('careful');
    expect(written.join('')).toContain('example.a');
  });

  test('respects the threshold', () => {
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = createConsoleLogger('warn');
      logger.debug('invisible');
      logger.info('also invisible');
      logger.error('visible');
    } finally {
      process.stderr.write = original;
    }

    expect(written.join('')).not.toContain('invisible');
    expect(written.join('')).toContain('visible');
  });
});
