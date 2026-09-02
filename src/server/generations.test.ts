import { describe, expect, test } from 'bun:test';
import { Generations, type OpenedWorkspace } from './generations.ts';
import { defineProvider, type ProviderManifest } from '#connectivity';
import { ASSERTION_GRANT, clearMintedTokens, resolveAssertionToken } from '#connectivity/auth/index.ts';
import { EMPTY_PROFILE_POLICY } from '#policy';
import type { ProfileRuntime } from './mcp/index.ts';

/**
 * The generation lifecycle, at the level where it is actually decidable.
 *
 * Driving this over HTTP would mean racing a request against a reload and
 * hoping the interleaving lands where the assertion needs it. What the design
 * claims is narrower and exactly testable here: a generation replaced while a
 * request holds it is not closed until that request lets go.
 */

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A runtime with nothing in it, but the right shape.
 *
 * It used to be `{} as ProfileRuntime`, which held while nothing on the reload
 * path looked inside one. A reload now counts what the new generation
 * advertises — so it reads the registry and the policy, and an empty object
 * throws. Empty *contents* still say everything these tests are about; an empty
 * *object* only ever said that nobody had looked yet.
 */
function emptyRuntime(): ProfileRuntime {
  return {
    config: { grants: [] },
    registry: { revision: 0, capabilities: () => [] },
    policy: EMPTY_PROFILE_POLICY,
  } as unknown as ProfileRuntime;
}

/** A workspace that records whether it was closed, and how often. */
function stub(name: string): OpenedWorkspace & { closes: number } {
  const profiles = new Map<string, ProfileRuntime>([[name, emptyRuntime()]]);
  return {
    profiles,
    closes: 0,
    close() {
      this.closes += 1;
      return Promise.resolve();
    },
  };
}

function generationsOver(
  first: OpenedWorkspace,
  next: () => Promise<OpenedWorkspace>,
): Generations {
  return new Generations(first, next, { primary: 'personal', log: SILENT });
}

describe('reload', () => {
  test('swaps in the reopened workspace and advances the epoch', async () => {
    const before = stub('before');
    const after = stub('after');
    const generations = generationsOver(before, () => Promise.resolve(after));

    expect(generations.current.epoch).toBe(0);
    expect(generations.current.names()).toEqual(['before']);

    const result = await generations.reload();

    expect(result.reloaded).toBe(true);
    expect(result.epoch).toBe(1);
    expect(result.profiles).toEqual(['after']);
    expect(generations.current.names()).toEqual(['after']);
  });

  test('closes the generation it replaced', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () => Promise.resolve(stub('after')));

    await generations.reload();

    expect(before.closes).toBe(1);
  });

  test('a failure keeps the previous generation serving, and says why', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () =>
      Promise.reject(new Error('profiles/personal/profile.yaml: could not parse YAML')),
    );

    const result = await generations.reload();

    expect(result.reloaded).toBe(false);
    expect(result.reason).toContain('could not parse YAML');
    // The endpoint is still serving what it was serving, and the runtimes
    // behind it are still open. A config caught mid-write must not be able to
    // take an endpoint down.
    expect(result.epoch).toBe(0);
    expect(generations.current.names()).toEqual(['before']);
    expect(before.closes).toBe(0);
  });

  test('two concurrent reloads open one workspace, not two', async () => {
    let opened = 0;
    const generations = generationsOver(stub('before'), async () => {
      opened += 1;
      await Promise.resolve();
      return stub('after');
    });

    const [first, second] = await Promise.all([generations.reload(), generations.reload()]);

    expect(opened).toBe(1);
    expect(first).toEqual(second);
  });
});

describe('a pinned generation', () => {
  test('is not closed while a request still holds it', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () => Promise.resolve(stub('after')));

    const held = generations.acquire();
    await generations.reload();

    // Replaced, so nothing new reaches it — but the request that started
    // against it is still using its connectors and its audit log.
    expect(generations.current.names()).toEqual(['after']);
    expect(before.closes).toBe(0);

    await generations.release(held);
    expect(before.closes).toBe(1);
  });

  test('serves the request that started on it, not the one that replaced it', async () => {
    const generations = generationsOver(stub('before'), () => Promise.resolve(stub('after')));

    const held = generations.acquire();
    await generations.reload();

    expect(held.names()).toEqual(['before']);
    expect(generations.current.names()).toEqual(['after']);

    await generations.release(held);
  });

  test('closes once, however many requests were holding it', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () => Promise.resolve(stub('after')));

    const first = generations.acquire();
    const second = generations.acquire();
    await generations.reload();

    await generations.release(first);
    expect(before.closes).toBe(0);

    await generations.release(second);
    expect(before.closes).toBe(1);

    // A late release must not close it a second time — closing a runtime twice
    // is an error that surfaces long after the work succeeded.
    await generations.release(second);
    expect(before.closes).toBe(1);
  });
});

/**
 * The caches that outlive a generation, and why a reload has to empty them.
 *
 * Both are module-global and keyed by connection, so replacing the workspace
 * does nothing to them. That is deliberate — an unchanged connection should not
 * pay a round trip for somebody else's edit — and it is exactly why a reload
 * has to say otherwise: `connect` is how a connection changes hands or changes
 * route, and it lands as a reload. A cache that survived it would serve the
 * previous account for up to an hour after the config said otherwise.
 *
 * Only the minted-token half is exercised here. `clearUpstreamTokens` needs a
 * refresh-capable OAuth provider to observe at all, and it is not the one that
 * was missing.
 */

const KEY_REF = 'vendor/key';

async function keyed(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, '$1\n');

  return JSON.stringify({
    type: 'service_account',
    client_email: 'link@my-project.iam.gserviceaccount.example',
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    token_uri: 'https://tokens.example.test/token',
    private_key_id: 'abc123',
  });
}

function keyedProvider(): ProviderManifest {
  return defineProvider({
    id: 'vendor_thing',
    name: 'Vendor Thing',
    connector: { kind: 'http', base_url: 'https://api.example.test', openapi: './t.json' },
    auth: {
      kind: 'oauth',
      registration: 'manual',
      app: 'vendor',
      scopes: ['read.example'],
      authorize_url: 'https://accounts.example.test/authorize',
      token_url: 'https://tokens.example.test/token',
      assertion: {
        method: 'service_account',
        label: 'Service account key',
        delegation: 'optional',
        key_ref: KEY_REF,
        reach: 'only what is shared with it',
        subject_label: 'Account to act as',
        setup: {
          steps: [],
          prompts: [
            { key: 'key', label: 'Key', secret: true, scope: 'shared', credential_ref: KEY_REF },
          ],
        },
      },
    },
    setup: {
      steps: [],
      prompts: [
        { key: 'client_id', label: 'Client id', scope: 'shared', credential_ref: 'vendor/client_id' },
        { key: 'client_secret', label: 'Client secret', secret: true, scope: 'shared', credential_ref: 'vendor/client_secret' },
      ],
    },
  });
}

describe('a minted token', () => {
  test('is re-minted after a reload, because the connection may not be the same one', async () => {
    clearMintedTokens();

    const manifest = keyedProvider();
    const key = await keyed();
    const credentials = { get: async (ref: string) => (ref === KEY_REF ? key : null) } as never;
    const stored = { grant: ASSERTION_GRANT, key_ref: KEY_REF } as const;

    let exchanges = 0;
    const fetch = (async () => {
      exchanges += 1;
      return new Response(JSON.stringify({ access_token: `token-${exchanges}`, expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const mint = () =>
      resolveAssertionToken({ manifest, connectionId: 'main', stored, credentials, fetch });

    expect(await mint()).toBe('token-1');
    // The cache doing its job — the reason it exists, and the reason clearing it
    // has to be deliberate rather than incidental.
    expect(await mint()).toBe('token-1');
    expect(exchanges).toBe(1);

    const generations = generationsOver(stub('before'), () => Promise.resolve(stub('after')));
    await generations.reload();

    expect(await mint()).toBe('token-2');
    expect(exchanges).toBe(2);
  });
});
