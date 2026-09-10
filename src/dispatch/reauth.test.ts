import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerPrincipal } from '#auth';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { createBlobAuditStore } from '#deployments/adapters/audit-blob.ts';
import { RateLimiter } from '#policy';
import { createHttpConnector } from '#connectivity/transports';
import { defineProvider, type AnyConnector } from '#connectivity';
import { parseConfig } from '#profile';
import { Dispatcher } from './dispatch.ts';
import { ProviderRegistry, toPolicyDocument } from '#registry';

/**
 * The seam, wired.
 *
 * `reauthorize.test.ts` covers the decision and `http.test.ts` the retry. What
 * neither can show is the part that was actually broken in production: that a
 * 401 on an oauth connection reaches a verifier at all, and that a connection
 * whose credential a person has to change does not get a second refusal.
 */

const directory = await mkdtemp(join(tmpdir(), 'reauth-spec-'));
const specPath = join(directory, 'acme.json');

await writeFile(
  specPath,
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Acme', version: '1.0.0' },
    paths: {
      '/accounts': {
        get: { operationId: 'listAccounts', responses: { '200': { description: 'ok' } } },
      },
    },
  }),
);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const CONFIG = parseConfig(`
contract: 5
instance:
  profile: personal
limits:
  requests_per_minute: 100
  upstream_calls_per_minute: 100
grants:
  - { connection: acme.main, allow: ['acme.*'], deny: [] }
members: []
`).config;

const connector = { kind: 'http', base_url: 'https://api.acme.test/v1', openapi: specPath } as const;

const OAUTH = defineProvider({
  id: 'acme',
  name: 'Acme',
  connector,
  auth: {
    kind: 'oauth',
    // Dynamic registration keeps the manifest to the two fields this test is
    // about; what it authenticates with is beside the point, only that it can
    // be renewed without a person.
    registration: 'dynamic',
    scopes: ['read'],
    authorization_url: 'https://acme.test/authorize',
    token_url: 'https://acme.test/token',
  },
});

const BASIC = defineProvider({
  id: 'acme',
  name: 'Acme',
  connector,
  auth: { kind: 'basic', credential_ref: 'acme/password' },
});

/** A vendor that refuses the first call and accepts the second. */
function harness(manifest: typeof OAUTH) {
  const tokens: string[] = [];
  let attempt = 0;

  const registry = new ProviderRegistry();
  registry.register(manifest as never);

  const http = createHttpConnector({
    baseUrl: 'https://api.acme.test/v1',
    openapi: specPath,
    fetch: (async (request: Request) => {
      tokens.push(request.headers.get('authorization') ?? '');
      attempt += 1;
      return attempt === 1
        ? new Response('{"error":"Invalid Credentials"}', { status: 401, statusText: 'Unauthorized' })
        : new Response('{"accounts":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof globalThis.fetch,
  });

  let issued = 0;
  const dispatcher = new Dispatcher({
    config: CONFIG,
    connections: [{ id: 'main', provider: 'acme', account: 'A' }],
    oauthApps: [],
    registry,
    connectorFor: (): AnyConnector | undefined => http as unknown as AnyConnector,
    // Stands in for the credential resolver: a second call hands out a second
    // token, which is what a refresh looks like from here.
    authorizeRequest: async (_provider, _connection, request) => {
      issued += 1;
      const authorised = new Request(request, { headers: new Headers(request.headers) });
      authorised.headers.set('authorization', `Bearer token-${issued}`);
      return authorised;
    },
    policy: toPolicyDocument(CONFIG),
    state: createMemoryState(),
    audit: createBlobAuditStore({ storage: createMemoryBlobStore() }),
    credentials: createMemoryCredentials(),
    storage: createMemoryBlobStore(),
    limiter: new RateLimiter(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  return { dispatcher, tokens, registry, http };
}

const call = {
  principal: ownerPrincipal('personal'),
  capabilityId: 'acme.listAccounts',
  connectionKey: 'acme.main',
  arguments: {},
};

describe('a refused token on a connection that can renew itself', () => {
  test('is authorised again and the call succeeds, without anyone intervening', async () => {
    const { dispatcher, tokens, registry, http } = harness(OAUTH);
    registry.setDiscovered('acme', await http.discover({ manifest: OAUTH } as never));

    const outcome = await dispatcher.invoke(call);

    expect(outcome.ok).toBe(true);
    // Two tokens, not the same one twice: the retry is only worth making
    // because authorising again hands out a replacement.
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-2']);
  });
});

describe('a refused credential a person has to change', () => {
  test('is not retried, because a second refusal is all it would buy', async () => {
    const { dispatcher, tokens, registry, http } = harness(BASIC);
    registry.setDiscovered('acme', await http.discover({ manifest: BASIC } as never));

    await dispatcher.invoke(call);

    expect(tokens).toEqual(['Bearer token-1']);
  });
});
