import { describe, expect, test } from 'bun:test';
import { defineProvider, defineProviderWithStrategy } from '#connectivity';
import type { AuthConfig, AuthStrategy, ProviderContext } from '#connectivity';
import { refuseStrategy, strategyContextFrom, strategyFor } from './index.ts';

/**
 * The seam, on its own.
 *
 * A strategy is the one place per-vendor code is allowed, so the checks worth
 * having here are the ones that keep it *a seam*: that a manifest and the code
 * beside it cannot disagree silently, and that what a strategy is handed is
 * narrower than what a provider is handed.
 */

const strategy: AuthStrategy = {
  id: 'handshake',
  async authorize(request) {
    return request;
  },
};

const manifestFor = (auth: AuthConfig) =>
  defineProvider({
    id: 'acme',
    name: 'Acme',
    connector: { kind: 'http', base_url: 'https://api.acme.test/v1', openapi: './acme.json' },
    auth,
  });

const declared = manifestFor({
  kind: 'strategy',
  strategy: 'handshake',
  credential_ref: 'acme/api_key',
  options: { sandbox: true },
});

/** Only the four keys `strategyContextFrom` reads. */
const providerContext = {
  credentials: { get: async () => null } as unknown as ProviderContext['credentials'],
  state: { get: async () => null } as unknown as ProviderContext['state'],
  log: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as ProviderContext;

/** A registry, structurally — the two methods `strategyFor` asks for. */
const source = (...entries: Array<{ id: string; definition?: unknown }>) => ({
  get: (id: string) => entries.find((entry) => entry.id === id) as never,
  list: () => entries as never,
});

describe('strategyFor', () => {
  test('returns the strategy its own definition carries', () => {
    const definition = defineProviderWithStrategy({ manifest: declared, strategy });

    expect(strategyFor(declared, source({ id: 'acme', definition }))).toBe(strategy);
  });

  test('refuses when nothing registered supplies one by that name', () => {
    // The failure `refuseStrategy` exists for: without it the request goes out
    // unauthenticated and the vendor explains the wrong problem.
    expect(() => strategyFor(declared, source())).toThrow(/"handshake" is not registered/);
  });

  test('refuses when the manifest and the code beside it disagree about which one', () => {
    const definition = defineProviderWithStrategy({ manifest: declared, strategy });
    const other = manifestFor({ kind: 'strategy', strategy: 'other' });

    expect(() => strategyFor(other, source({ id: 'acme', definition }))).toThrow(
      /declares auth strategy "other" but carries "handshake"/,
    );
  });

  test('a declaration-only manifest borrows a strategy another provider supplies', () => {
    // The workspace-YAML case, and the only way to point a connection at a
    // vendor's sandbox: a manifest in `providers.d/` has no definition at all,
    // so its strategy has to come from the built-in that carries the code.
    const definition = defineProviderWithStrategy({ manifest: declared, strategy });
    const borrower = manifestFor({ kind: 'strategy', strategy: 'handshake' });

    expect(strategyFor(borrower, source({ id: 'acme', definition }, { id: 'acme_sandbox' }))).toBe(
      strategy,
    );
  });

  test('refuses a manifest that declares no strategy at all', () => {
    expect(() => strategyFor(manifestFor({ kind: 'bearer' }), source())).toThrow(
      /does not declare a strategy/,
    );
  });
});

describe('defineProviderWithStrategy', () => {
  test('refuses a manifest whose auth kind is not strategy', () => {
    expect(() => defineProviderWithStrategy({ manifest: manifestFor({ kind: 'bearer' }), strategy })).toThrow(
      /declares auth.kind "bearer"/,
    );
  });

  test('refuses a manifest naming a different strategy', () => {
    expect(() =>
      defineProviderWithStrategy({
        manifest: manifestFor({ kind: 'strategy', strategy: 'other' }),
        strategy,
      }),
    ).toThrow(/but carries "handshake"/);
  });

  test('carries no capabilities unless it is given some', () => {
    expect(defineProviderWithStrategy({ manifest: declared, strategy }).capabilities).toEqual([]);
  });
});

describe('strategyContextFrom', () => {
  const context = strategyContextFrom({
    source: providerContext,
    manifest: declared,
    connectionId: 'main',
    profile: 'personal',
  });

  test('passes the manifest options through, so a strategy is configurable as data', () => {
    expect(context.options).toEqual({ sandbox: true });
  });

  test('carries the connection it is acting for', () => {
    expect(context.connectionId).toBe('main');
    // One process serves every profile, so a strategy caching anything in
    // memory needs this to build a key that cannot collide.
    expect(context.profile).toBe('personal');
    expect(context.credentials).toBe(providerContext.credentials);
    expect(context.state).toBe(providerContext.state);
  });

  test('has no write, so per-request code structurally cannot store a credential', () => {
    // The restriction that matters. A handshake persists what it produces and
    // must only be able to during setup; the absence of the key is the rule.
    expect(context.write).toBeUndefined();
  });

  test('an auth kind without options still yields an object rather than undefined', () => {
    const bearer = strategyContextFrom({
      source: providerContext,
      manifest: manifestFor({ kind: 'bearer' }),
      connectionId: 'main',
      profile: 'personal',
    });

    expect(bearer.options).toEqual({});
  });
});

describe('refuseStrategy', () => {
  test('names the strategy and where to read about them', () => {
    expect(() => refuseStrategy('handshake')).toThrow(/creating-a-provider\.md/);
  });
});
