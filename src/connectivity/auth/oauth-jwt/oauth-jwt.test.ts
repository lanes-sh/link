import { describe, expect, test, beforeEach } from 'bun:test';
import { defineProvider, type ProviderManifest } from '#connectivity';
import { parseAssertionKey, signAssertion } from './key.ts';
import {
  ASSERTION_GRANT,
  clearMintedTokens,
  isStoredAssertion,
  resolveAssertionToken,
  storedAssertionFor,
} from './index.ts';

/**
 * The protocol half of the key route, against a key generated here.
 *
 * Nothing in this file touches a real account or a real endpoint, which is the
 * only way the claim set is checkable at all: an assertion is a signature over
 * exactly what went into it, so the thing worth asserting is what went in.
 */

const TOKEN_URL = 'https://tokens.example.test/token';

/** A throwaway RSA key, so the signature is real and belongs to nobody. */
async function generateKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, '$1\n');

  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

function keyFile(pem: string): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'link@my-project.iam.gserviceaccount.example',
    private_key: pem,
    token_uri: TOKEN_URL,
    private_key_id: 'abc123',
  });
}

/** JWT's alphabet back to binary, padding restored. */
function decodeBase64url(segment: string): string {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(decodeBase64url(segment));
}

function manifestWith(scopes: readonly string[]): ProviderManifest {
  return defineProvider({
    id: 'vendor_thing',
    name: 'Vendor Thing',
    connector: { kind: 'http', base_url: 'https://api.example.test', openapi: './t.json' },
    auth: {
      kind: 'oauth',
      registration: 'manual',
      app: 'vendor',
      scopes,
      authorize_url: 'https://accounts.example.test/authorize',
      token_url: TOKEN_URL,
      assertion: {
        method: 'service_account',
        label: 'Service account key',
        delegation: 'optional',
        key_ref: 'vendor/key',
        reach: 'only what is shared with it',
        subject_label: 'Account to act as',
        setup: {
          steps: [],
          prompts: [
            { key: 'key', label: 'Key', secret: true, scope: 'shared', credential_ref: 'vendor/key' },
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

/** The narrowest thing that satisfies `SecretStore` for these tests. */
function store(entries: Record<string, string>) {
  const held = new Map(Object.entries(entries));
  return {
    get: async (ref: string) => held.get(ref) ?? null,
    set: async (ref: string, value: string) => void held.set(ref, value),
    has: async (ref: string) => held.has(ref),
    delete: async (ref: string) => void held.delete(ref),
    list: async () => [...held.keys()],
  } as never;
}

describe('the key file', () => {
  test('is parsed when it is the account key', async () => {
    const { pem } = await generateKey();
    const key = parseAssertionKey(keyFile(pem), 'vendor/key');

    expect(key.client_email).toBe('link@my-project.iam.gserviceaccount.example');
    expect(key.token_uri).toBe(TOKEN_URL);
  });

  test('names the mistake when it is the OAuth client file instead', () => {
    const client = JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } });

    expect(() => parseAssertionKey(client, 'vendor/key')).toThrow(/client.*file, not an account key/i);
  });

  test('says so when it is not JSON at all', () => {
    expect(() => parseAssertionKey('ya29.not-a-key', 'vendor/key')).toThrow(/not JSON/);
  });
});

describe('the assertion', () => {
  test('claims the scopes asked for, and verifies against the key that signed it', async () => {
    const { pem, publicKey } = await generateKey();
    const key = parseAssertionKey(keyFile(pem), 'vendor/key');

    const now = 1_700_000_000_000;
    const jwt = await signAssertion({ key, scopes: ['read.example', 'write.example'], now });

    const [header, claims, signature] = jwt.split('.');
    expect(decodeSegment(header!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abc123' });
    expect(decodeSegment(claims!)).toEqual({
      iss: 'link@my-project.iam.gserviceaccount.example',
      scope: 'read.example write.example',
      aud: TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });

    const bytes = Uint8Array.from(decodeBase64url(signature!), (character) => character.charCodeAt(0));

    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        bytes as unknown as ArrayBuffer,
        new TextEncoder().encode(`${header}.${claims}`) as unknown as ArrayBuffer,
      ),
    ).toBe(true);
  });

  test('carries no sub at all when it acts as nobody', async () => {
    const { pem } = await generateKey();
    const key = parseAssertionKey(keyFile(pem), 'vendor/key');

    const claims = decodeSegment((await signAssertion({ key, scopes: ['read.example'] })).split('.')[1]!);

    // Absent, not empty: an empty `sub` is a different request and servers
    // treat it as malformed rather than as unset.
    expect('sub' in claims).toBe(false);
  });

  test('carries sub when it acts as someone', async () => {
    const { pem } = await generateKey();
    const key = parseAssertionKey(keyFile(pem), 'vendor/key');

    const claims = decodeSegment(
      (await signAssertion({ key, scopes: ['read.example'], subject: 'someone@example.com' })).split('.')[1]!,
    );

    expect(claims['sub']).toBe('someone@example.com');
  });

  test('reads a key whose newlines arrived escaped', async () => {
    const { pem } = await generateKey();
    const escaped = keyFile(pem.replaceAll('\n', '\\n'));

    // The same key, carried through an environment variable or a JSON string.
    // Refusing it would be a failure with no visible cause in a terminal.
    await expect(
      signAssertion({ key: parseAssertionKey(escaped, 'vendor/key'), scopes: ['read.example'] }),
    ).resolves.toContain('.');
  });
});

describe('a stored credential', () => {
  beforeEach(() => clearMintedTokens());

  test('is recognised as an assertion by its shape, and an OAuth blob is not', async () => {
    expect(isStoredAssertion({ grant: ASSERTION_GRANT, key_ref: 'vendor/key' })).toBe(true);
    expect(isStoredAssertion({ access_token: 'x', refresh_token: 'y' })).toBe(false);
    expect(isStoredAssertion({ grant: ASSERTION_GRANT })).toBe(false);
  });

  test('is read back for the connection that holds one', async () => {
    const manifest = manifestWith(['read.example']);
    const secrets = store({
      'vendor_thing/main': JSON.stringify({ grant: ASSERTION_GRANT, key_ref: 'vendor/key' }),
    });

    expect(await storedAssertionFor(manifest, 'main', secrets)).toMatchObject({ key_ref: 'vendor/key' });
  });

  test('is null for a connection that authorised in a browser', async () => {
    const manifest = manifestWith(['read.example']);
    const secrets = store({
      'vendor_thing/main': JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    });

    expect(await storedAssertionFor(manifest, 'main', secrets)).toBeNull();
  });

  test('is null for a pasted token that is not JSON', async () => {
    const manifest = manifestWith(['read.example']);
    const secrets = store({ 'vendor_thing/main': 'github_pat_example' });

    expect(await storedAssertionFor(manifest, 'main', secrets)).toBeNull();
  });
});

describe('the exchange', () => {
  beforeEach(() => clearMintedTokens());

  async function fixture(scopes = ['read.example']) {
    const { pem } = await generateKey();
    return {
      manifest: manifestWith(scopes),
      secrets: store({ 'vendor/key': keyFile(pem) }),
      stored: { grant: ASSERTION_GRANT, key_ref: 'vendor/key' } as const,
    };
  }

  test('presents the assertion at the endpoint named in the key file', async () => {
    const { manifest, secrets, stored } = await fixture();
    let seen: { url: string; body: URLSearchParams } | undefined;

    const token = await resolveAssertionToken({
      manifest,
      connectionId: 'main',
      stored,
      credentials: secrets,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url: String(url), body: init.body as URLSearchParams };
        return Response.json({ access_token: 'minted', expires_in: 3600 });
      }) as unknown as typeof fetch,
    });

    expect(token).toBe('minted');
    expect(seen?.url).toBe(TOKEN_URL);
    expect(seen?.body.get('grant_type')).toBe(ASSERTION_GRANT);
    expect(seen?.body.get('assertion')?.split('.')).toHaveLength(3);
  });

  test('mints once and serves the same token again', async () => {
    const { manifest, secrets, stored } = await fixture();
    let calls = 0;

    const mint = () =>
      resolveAssertionToken({
        manifest,
        connectionId: 'main',
        stored,
        credentials: secrets,
        fetch: (async () => {
          calls += 1;
          return Response.json({ access_token: `minted-${calls}`, expires_in: 3600 });
        }) as unknown as typeof fetch,
      });

    expect(await mint()).toBe('minted-1');
    expect(await mint()).toBe('minted-1');
    expect(calls).toBe(1);
  });

  test('mints again once the cached token is close to expiring', async () => {
    const { manifest, secrets, stored } = await fixture();
    let calls = 0;

    const mint = () =>
      resolveAssertionToken({
        manifest,
        connectionId: 'main',
        stored,
        credentials: secrets,
        fetch: (async () => {
          calls += 1;
          // Inside the skew, so the cache must not be trusted for the next call.
          return Response.json({ access_token: `minted-${calls}`, expires_in: 30 });
        }) as unknown as typeof fetch,
      });

    expect(await mint()).toBe('minted-1');
    expect(await mint()).toBe('minted-2');
  });

  test('says which grant is missing when delegation was never authorised', async () => {
    const { manifest, secrets } = await fixture(['read.example', 'write.example']);

    const refused = resolveAssertionToken({
      manifest,
      connectionId: 'main',
      stored: { grant: ASSERTION_GRANT, key_ref: 'vendor/key', subject: 'someone@example.com' },
      credentials: secrets,
      fetch: (async () =>
        Response.json({ error: 'unauthorized_client' }, { status: 401 })) as unknown as typeof fetch,
    });

    // The scope list, verbatim, because a partial one is refused identically
    // and the refusal does not say which was short.
    await expect(refused).rejects.toThrow(/act as someone@example\.com[\s\S]*read\.example[\s\S]*write\.example/);
  });

  test('lists what invalid_grant can mean rather than asserting one of them', async () => {
    const { manifest, secrets, stored } = await fixture();

    const refused = resolveAssertionToken({
      manifest,
      connectionId: 'main',
      stored,
      credentials: secrets,
      fetch: (async () =>
        Response.json(
          { error: 'invalid_grant', error_description: 'Invalid grant: account not found' },
          { status: 400 },
        )) as unknown as typeof fetch,
    });

    // Google returns this one code for an account that does not exist, a deleted
    // key, a wrong clock and a missing subject. Only the description tells them
    // apart, so it leads and the causes are listed under it.
    await expect(refused).rejects.toThrow(/account not found[\s\S]*clock is wrong[\s\S]*acts\n    as nobody/);
  });

  test('refuses when the key it points at is gone, naming the command that fixes it', async () => {
    const manifest = manifestWith(['read.example']);

    await expect(
      resolveAssertionToken({
        manifest,
        connectionId: 'main',
        stored: { grant: ASSERTION_GRANT, key_ref: 'vendor/key' },
        credentials: store({}),
        fetch: (async () => Response.json({})) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/No key stored at vendor\/key[\s\S]*connect vendor_thing --replace/);
  });
});
