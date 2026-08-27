import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '#registry';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { defineProvider, defineProviderWithStrategy } from '#connectivity';
import type { AuthStrategy, AuthStrategyContext } from '#connectivity';
import { runStrategySetup } from './strategy.ts';

/**
 * The half of the seam that only `connect` has: a writable credential store.
 *
 * Every other caller of a strategy is on the dispatch path, where `write` is
 * deliberately absent. These tests pin the two things that would otherwise go
 * unnoticed until a real handshake ran — that the writer works and lands where
 * the connection can read it back, and that a provider without a strategy is
 * untouched rather than refused.
 */

const strategyManifest = defineProvider({
  id: 'acme',
  name: 'Acme',
  connector: { kind: 'http', base_url: 'https://api.acme.test/v1', openapi: './acme.json' },
  auth: { kind: 'strategy', strategy: 'handshake', options: { sandbox: true } },
});

const plainManifest = defineProvider({
  id: 'plain',
  name: 'Plain',
  connector: { kind: 'http', base_url: 'https://api.plain.test/v1', openapi: './plain.json' },
  auth: { kind: 'bearer' },
});

function harness(setup?: AuthStrategy['setup']) {
  const seen: AuthStrategyContext[] = [];
  /** What the handshake read before it overwrote it. */
  const read: Array<string | null> = [];
  const strategy: AuthStrategy = {
    id: 'handshake',
    async authorize(request) {
      return request;
    },
    ...(setup
      ? { setup }
      : {
          async setup(context) {
            seen.push(context);
            read.push(await context.credentials.get(`acme/${context.connectionId}`));
            await context.write!(`acme/${context.connectionId}`, 'the whole context');
          },
        }),
  };

  const registry = new ProviderRegistry();
  registry.register(defineProviderWithStrategy({ manifest: strategyManifest, strategy }));
  registry.register(plainManifest);

  return {
    seen,
    read,
    registry,
    credentials: createMemoryCredentials({ 'acme/pending': 'pasted-api-key' }),
    state: createMemoryState(),
  };
}

describe('runStrategySetup', () => {
  test('runs the handshake and its write reaches the store', async () => {
    const bench = harness();
    await runStrategySetup(strategyManifest, 'pending', bench);

    expect(await bench.credentials.get('acme/pending')).toBe('the whole context');
  });

  test('the strategy can read what the operator pasted', async () => {
    const bench = harness();
    await runStrategySetup(strategyManifest, 'pending', bench);

    // Read during the handshake, because the handshake then replaces it — the
    // API key is the input to an installation, and the whole context is the output.
    expect(bench.read).toEqual(['pasted-api-key']);
  });

  test('carries the manifest options, so one provider can serve two environments', async () => {
    const bench = harness();
    await runStrategySetup(strategyManifest, 'pending', bench);

    expect(bench.seen[0]!.options).toEqual({ sandbox: true });
  });

  test('credentials are scoped to this connection and nothing else', async () => {
    const bench = harness();
    await bench.credentials.set('acme/somebody-else', 'not yours');
    await runStrategySetup(strategyManifest, 'pending', bench);

    expect(bench.seen[0]!.credentials.get('acme/somebody-else')).rejects.toThrow();
  });

  test('state is scoped too, so a session cannot be read across connections', async () => {
    const bench = harness();
    await runStrategySetup(strategyManifest, 'pending', bench);
    await bench.seen[0]!.state.set('session', 'token');

    // Same registry and the same stores, a different connection.
    await runStrategySetup(strategyManifest, 'other', bench);

    expect(await bench.seen[1]!.state.get('session')).toBeNull();
  });

  test('a provider with no strategy is left alone', async () => {
    const bench = harness();

    expect(runStrategySetup(plainManifest, 'main', bench)).resolves.toBeUndefined();
  });

  test('a manifest naming a strategy nothing carries refuses, rather than connecting half a provider', async () => {
    const bench = harness();
    const registry = new ProviderRegistry();
    registry.register(strategyManifest);

    expect(runStrategySetup(strategyManifest, 'pending', { ...bench, registry })).rejects.toThrow(
      /"handshake" is not registered/,
    );
  });

  test('a failing handshake propagates, so connect stops before writing config', async () => {
    const bench = harness(async () => {
      throw new Error('bunq /device-server answered 400: wrong key');
    });

    expect(runStrategySetup(strategyManifest, 'pending', bench)).rejects.toThrow(/wrong key/);
  });
});
