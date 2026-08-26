import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '#registry';
import { createMemoryCredentials } from '#stores/state/testing.ts';
import { defineProvider } from '#connectivity';
import { connectorFactory } from '#connectivity/transports';
import { requestAuthorizer } from './authorize.ts';
import { credentialResolver } from './resolve.ts';
import { bearerToken, bearerTokenAsStored } from './token.ts';
import { clearUpstreamTokens } from './oauth-authcode/provider.ts';

/**
 * The factory's cache, which for a long time did not exist.
 *
 * `connectorFactory` used to take the connection at construction and return a
 * function of the provider alone, so every caller built a fresh factory — and a
 * fresh `Map` — per lookup. Nothing was ever reused. It went unnoticed because
 * `mcp` and `http` are request-shaped, and a redundant instance of either costs
 * nothing at all.
 *
 * It stops being free the moment a kind holds a session. These tests pin the
 * behaviour a stateful connector depends on: same key, same instance.
 */

const registry = new ProviderRegistry();

registry.register(
  defineProvider({
    id: 'acme',
    name: 'Acme',
    connector: { kind: 'http', base_url: 'https://api.acme.test', openapi: './acme.json' },
    auth: { kind: 'header', header: 'X-API-Key', credential_ref: 'acme/api_key' },
  }),
);

const factoryFor = () =>
  connectorFactory({ registry, credentials: createMemoryCredentials({}) });

describe('connectorFactory', () => {
  test('the same provider and connection get the same instance', () => {
    const connectorFor = factoryFor();

    expect(connectorFor('acme', 'main')).toBe(connectorFor('acme', 'main'));
  });

  test('a different connection gets a different instance', () => {
    // Two accounts of one provider hold two different credentials, and — once
    // a kind holds a session — two different sessions. Sharing one instance
    // between them would be the worst kind of bug: it would work.
    const connectorFor = factoryFor();

    expect(connectorFor('acme', 'main')).not.toBe(connectorFor('acme', 'other'));
  });

  test('an unknown provider is undefined rather than a throw', () => {
    expect(factoryFor()('nothing', 'main')).toBeUndefined();
  });

  test('closeAll empties the cache, so the next lookup rebuilds', async () => {
    const connectorFor = factoryFor();
    const first = connectorFor('acme', 'main');

    await connectorFor.closeAll();

    expect(connectorFor('acme', 'main')).not.toBe(first);
  });

  test('closeAll survives a connector whose close throws', async () => {
    // A socket that will not shut down cleanly is not a reason to fail the
    // command that already finished, so this must not reject.
    const connectorFor = factoryFor();
    const connector = connectorFor('acme', 'main')!;
    (connector as { close?: () => Promise<void> }).close = () => Promise.reject(new Error('nope'));

    expect(connectorFor.closeAll()).resolves.toBeUndefined();
  });
});

/**
 * One reader of the credential store, two consumers.
 *
 * `requestAuthorizer` turns the result into headers; a non-HTTP connector takes
 * the resolver directly, because IMAP has no `Request` to hand an authorizer
 * and no headers to get back.
 */

const HTTP = { kind: 'http', base_url: 'https://api.test', openapi: './t.json' } as const;

function withAuth(auth: Record<string, unknown>, stored: Record<string, string>) {
  const registry = new ProviderRegistry();
  registry.register(defineProvider({ id: 'acme2', name: 'Acme2', connector: HTTP, auth }));
  const credentials = createMemoryCredentials(stored);

  return {
    resolve: credentialResolver(registry, credentials),
    authorize: requestAuthorizer(registry, credentials),
  };
}

const sent = async (
  authorize: ReturnType<typeof requestAuthorizer>,
  connection = 'main',
): Promise<Request> => authorize('acme2', connection, new Request('https://api.test/v1/things'));

describe('credentialResolver', () => {
  test('basic splits on the first colon only', async () => {
    // RFC 7617 forbids a colon in the userid but permits one in the password,
    // so splitting on the last — or on all — would corrupt a legal password.
    const { resolve } = withAuth({ kind: 'basic' }, { 'acme2/main': 'ada@example.com:pa:ss:word' });

    expect(await resolve('acme2', 'main')).toEqual({
      kind: 'basic',
      username: 'ada@example.com',
      password: 'pa:ss:word',
    });
  });

  test('basic with no colon says what is wrong and how to fix it', async () => {
    const { resolve } = withAuth({ kind: 'basic' }, { 'acme2/main': 'just-a-password' });

    expect(resolve('acme2', 'main')).rejects.toThrow(/username:password/);
  });

  test('a missing credential names the ref it looked in', async () => {
    const { resolve } = withAuth({ kind: 'bearer' }, {});

    expect(resolve('acme2', 'main')).rejects.toThrow(/acme2\/main/);
  });

  test('it reads the ref the manifest chose, not an assumed one', async () => {
    const { resolve } = withAuth(
      { kind: 'header', credential_ref: 'acme2/api_key' },
      { 'acme2/api_key': 'k' },
    );

    expect(await resolve('acme2', 'anything')).toMatchObject({ kind: 'api_key', value: 'k' });
  });
});

describe('requestAuthorizer', () => {
  test('basic encodes UTF-8, which btoa did not', async () => {
    // `btoa` throws outright above U+00FF and, below it, silently encodes
    // Latin-1 bytes where RFC 7617 requires UTF-8 — producing a header that is
    // well-formed, type-correct, and rejected by the server.
    const { authorize } = withAuth({ kind: 'basic' }, { 'acme2/main': 'user:pässwort' });

    const header = (await sent(authorize)).headers.get('authorization');

    expect(header).toBe(`Basic ${Buffer.from('user:pässwort', 'utf8').toString('base64')}`);
    expect(header).not.toBe(`Basic ${btoa('user:pässwort')}`);
  });

  test('basic survives a password btoa would have thrown on', async () => {
    const { authorize } = withAuth({ kind: 'basic' }, { 'acme2/main': 'user:中文密码' });

    expect((await sent(authorize)).headers.get('authorization')).toBe(
      `Basic ${Buffer.from('user:中文密码', 'utf8').toString('base64')}`,
    );
  });

  test('an api key can go in the query, which the schema promised and never did', async () => {
    const { authorize } = withAuth({ kind: 'api_key', query: 'apikey' }, { 'acme2/main': 'K' });

    const request = await sent(authorize);

    expect(new URL(request.url).searchParams.get('apikey')).toBe('K');
    expect(request.headers.get('x-api-key')).toBeNull();
  });

  test('relocating for a query key keeps the method and body', async () => {
    const { authorize } = withAuth({ kind: 'api_key', query: 'apikey' }, { 'acme2/main': 'K' });

    const request = await authorize(
      'acme2',
      'main',
      new Request('https://api.test/v1/things?page=2', { method: 'POST', body: 'payload' }),
    );

    expect(request.method).toBe('POST');
    expect(await request.text()).toBe('payload');
    // The existing query survives; the key is added beside it.
    expect(new URL(request.url).searchParams.get('page')).toBe('2');
  });

  test('bearer honours a manifest-chosen header', async () => {
    const { authorize } = withAuth({ kind: 'bearer', header: 'x-auth' }, { 'acme2/main': 'T' });

    expect((await sent(authorize)).headers.get('x-auth')).toBe('Bearer T');
  });

  test('two accounts of one provider read two different credentials', async () => {
    const { authorize } = withAuth({ kind: 'bearer' }, { 'acme2/one': 'A', 'acme2/two': 'B' });

    expect((await sent(authorize, 'one')).headers.get('authorization')).toBe('Bearer A');
    expect((await sent(authorize, 'two')).headers.get('authorization')).toBe('Bearer B');
  });
});

/**
 * The token a transport sends when it has no `Request` to authorise.
 *
 * An mcp connector sends `Authorization: Bearer <token>` and nothing else, so
 * it takes a token rather than a request — and two unrelated arrangements
 * produce one. Every caller used to ask the OAuth provider, which answered
 * `null` for a pasted token instead of raising: the ref it reads is identical,
 * so it found the token, failed to parse it as a JSON blob, and returned
 * undefined by design. The connection then went upstream unauthenticated.
 */

const MCP = { kind: 'mcp', endpoint: 'https://mcp.test/mcp' } as const;

const mcpProvider = (auth: Record<string, unknown>) =>
  defineProvider({ id: 'acme3', name: 'Acme3', connector: MCP, auth });

const future = () => Date.now() + 3_600_000;

describe('bearerToken', () => {
  test('a pasted token comes back exactly as stored', async () => {
    const credentials = createMemoryCredentials({ 'acme3/main': 'a-pasted-token' });

    expect(await bearerToken(mcpProvider({ kind: 'bearer' }), 'main', credentials)).toBe(
      'a-pasted-token',
    );
  });

  test('an oauth provider comes back as its access token', async () => {
    clearUpstreamTokens();
    const credentials = createMemoryCredentials({
      'acme3/live': JSON.stringify({ access_token: 'AT', expires_at: future() }),
    });

    const manifest = mcpProvider({ kind: 'oauth', registration: 'dynamic' });
    expect(await bearerToken(manifest, 'live', credentials)).toBe('AT');
  });

  test('a provider that authenticates to nothing has no token', async () => {
    const manifest = defineProvider({ id: 'acme3', name: 'Acme3', connector: MCP });

    expect(await bearerToken(manifest, 'main', createMemoryCredentials({}))).toBeNull();
  });

  test('a missing credential raises, naming the ref and what would store one', async () => {
    // The regression this whole helper exists for. `null` here is a request
    // sent with no Authorization header at all: no error, an empty tool list,
    // and nothing to read that says why.
    const promise = bearerToken(mcpProvider({ kind: 'bearer' }), 'main', createMemoryCredentials({}));

    // The provider, not a command: this is raised inside a running endpoint,
    // which knows the profile and never the target, so a printed `lanes link
    // connect` would be a paste that writes into the wrong store or refuses.
    expect(promise).rejects.toThrow(/No credential stored at acme3\/main.*acme3/s);
  });

  test('a credential that cannot be a bearer token says which kind it is', async () => {
    // Unreachable through `defineProvider`, which refuses these on an mcp
    // connector — so this is the pin that keeps the guard and this switch from
    // drifting apart quietly if either is ever relaxed.
    const manifest = defineProvider({ id: 'acme3', name: 'Acme3', connector: HTTP, auth: { kind: 'basic' } });
    const credentials = createMemoryCredentials({ 'acme3/main': 'ada:secret' });

    expect(bearerToken(manifest, 'main', credentials)).rejects.toThrow(/"basic"/);
  });
});

describe('bearerTokenAsStored', () => {
  test('an expired oauth token is handed back rather than refreshed', async () => {
    // What `connect` needs: the token exactly as just written. Refreshing here
    // would spend a network round trip on a token seconds old, and would cache
    // it under the provisional connection id — a key naming a connection that
    // stops existing a moment later.
    clearUpstreamTokens();
    const credentials = createMemoryCredentials({
      'acme3/pending': JSON.stringify({
        access_token: 'STALE',
        refresh_token: 'R',
        expires_at: Date.now() - 1_000,
      }),
    });

    const manifest = mcpProvider({ kind: 'oauth', registration: 'dynamic' });
    expect(await bearerTokenAsStored(manifest, 'pending', credentials)).toBe('STALE');
  });

  test('a pasted token reads the same either way, having no other reading', async () => {
    const credentials = createMemoryCredentials({ 'acme3/main': 'a-pasted-token' });
    const manifest = mcpProvider({ kind: 'bearer' });

    expect(await bearerTokenAsStored(manifest, 'main', credentials)).toBe(
      await bearerToken(manifest, 'main', credentials),
    );
  });
});
