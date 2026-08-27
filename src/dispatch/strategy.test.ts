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
import {
  defineProvider,
  defineProviderWithStrategy,
  type AnyConnector,
  type AuthStrategy,
  type AuthStrategyContext,
} from '#connectivity';
import { parseConfig } from '#profile';
import { Dispatcher } from './dispatch.ts';
import { ProviderRegistry, toPolicyDocument } from '#registry';

/**
 * The seam, wired.
 *
 * `strategy/index.test.ts` covers the lookup in isolation. What matters here is
 * the part no unit test can show: that a request reaching a strategy provider
 * goes through the strategy instead of the credential resolver, that the
 * strategy sees the **body** — which is what a vendor that signs its requests
 * needs — and that a reply comes back through `verify`.
 */

const directory = await mkdtemp(join(tmpdir(), 'strategy-spec-'));
const specPath = join(directory, 'acme.json');

await writeFile(
  specPath,
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Acme', version: '1.0.0' },
    paths: {
      '/payments': {
        post: {
          operationId: 'createPayment',
          summary: 'Create a payment',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { amount: { type: 'string' }, to: { type: 'string' } },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  }),
);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
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
  - id: main
    provider: acme
    account: A
policy:
  allow:
    - "acme.*"
`).config;

const manifest = defineProvider({
  id: 'acme',
  name: 'Acme',
  connector: { kind: 'http', base_url: 'https://api.acme.test/v1', openapi: specPath },
  auth: {
    kind: 'strategy',
    strategy: 'handshake',
    credential_ref: 'acme/api_key',
    options: { sandbox: true },
  },
});

interface Seen {
  readonly signed: string;
  readonly context: AuthStrategyContext;
}

function harness() {
  const authorized: Seen[] = [];
  const verified: number[] = [];

  const strategy: AuthStrategy = {
    id: 'handshake',
    async authorize(request, context) {
      // Reading the body is the whole reason the seam takes a request rather
      // than an operation: a vendor that signs, signs this.
      authorized.push({ signed: await request.clone().text(), context });
      const stamped = new Request(request, { headers: new Headers(request.headers) });
      stamped.headers.set('x-acme-signature', 'signed');
      return stamped;
    },
    async verify(response, _context) {
      verified.push(response.status);
    },
  };

  const registry = new ProviderRegistry();
  registry.register(defineProviderWithStrategy({ manifest, strategy }));

  const requests: Request[] = [];
  const fetched = (async (request: Request) => {
    requests.push(request);
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  const connector = createHttpConnector({
    baseUrl: 'https://api.acme.test/v1',
    openapi: specPath,
    fetch: fetched,
  });

  const dispatcher = new Dispatcher({
    config: CONFIG,
    registry,
    connectorFor: (): AnyConnector | undefined => connector as unknown as AnyConnector,
    // A strategy provider must never reach this. It throws so the test would
    // fail loudly rather than quietly authenticating the ordinary way.
    authorizeRequest: async () => {
      throw new Error('the credential resolver was reached for a strategy provider');
    },
    policy: toPolicyDocument(CONFIG),
    state: createMemoryState(),
    audit: createBlobAuditStore({ storage: createMemoryBlobStore() }),
    credentials: createMemoryCredentials(),
    storage: createMemoryBlobStore(),
    limiter: new RateLimiter(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  return { dispatcher, registry, connector, authorized, verified, requests };
}

async function invoke() {
  const bench = harness();
  bench.registry.setDiscovered('acme', await bench.connector.discover({ manifest }));

  const outcome = await bench.dispatcher.invoke({
    principal: ownerPrincipal('personal'),
    capabilityId: 'acme.createPayment',
    connectionKey: 'acme.main',
    arguments: { amount: '10.00', to: 'NL00ACME0000000000' },
  });

  return { ...bench, outcome };
}

describe('a provider whose auth is a strategy', () => {
  test('reaches the vendor, and the strategy signed the way out', async () => {
    const { outcome, requests } = await invoke();

    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('x-acme-signature')).toBe('signed');
  });

  test('the strategy is handed the request body, not just its headers', async () => {
    const { authorized } = await invoke();

    expect(authorized).toHaveLength(1);
    expect(JSON.parse(authorized[0]!.signed)).toEqual({
      amount: '10.00',
      to: 'NL00ACME0000000000',
    });
  });

  test('the response comes back through verify', async () => {
    const { verified } = await invoke();

    expect(verified).toEqual([200]);
  });

  test('the context carries the manifest options and cannot write a credential', async () => {
    const { authorized } = await invoke();
    const context = authorized[0]!.context;

    expect(context.connectionId).toBe('main');
    expect(context.options).toEqual({ sandbox: true });
    expect(context.write).toBeUndefined();
  });

  test('state is scoped to the connection, which is where a session belongs', async () => {
    const { authorized } = await invoke();

    await authorized[0]!.context.state.set('session', 'token');
    expect(await authorized[0]!.context.state.get('session')).toBe('token');
  });
});
