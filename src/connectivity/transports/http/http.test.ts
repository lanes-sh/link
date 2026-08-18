import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorContext } from '#connectivity';
import { bundleForMethod, createHttpConnector, globMatches } from './index.ts';

/**
 * `discover` needs the provider id to strip a redundant prefix from operation
 * names — `gmail.users.labels.list` under provider `gmail` would otherwise
 * become `gmail_gmail_users_labels_list` on the wire.
 */
const CONTEXT = { manifest: { id: 'acme' } } as never;


/**
 * An OpenAPI document becomes capabilities with no translation code. These
 * tests use a spec shaped like a real one — path and query parameters, a
 * request body, tags, mixed methods — because that is where the fiddly parts
 * live.
 */

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Acme', version: '1.0.0' },
  servers: [{ url: 'https://api.acme.test/v1' }],
  paths: {
    '/accounts': {
      get: {
        operationId: 'listAccounts',
        summary: 'List accounts',
        tags: ['Account'],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          // An array query parameter, like Gmail's `metadataHeaders`.
          { name: 'status', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/accounts/{accountId}': {
      get: {
        operationId: 'getAccount',
        summary: 'Read one account',
        tags: ['Account'],
        parameters: [
          { name: 'accountId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/payments': {
      post: {
        operationId: 'createPayment',
        summary: 'Create a payment',
        tags: ['Payment'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { amount: { type: 'number' }, to: { type: 'string' } },
                required: ['amount', 'to'],
              },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
      delete: {
        operationId: 'cancelPayment',
        summary: 'Cancel',
        tags: ['Payment'],
        responses: { '204': { description: 'gone' } },
      },
    },
  },
};

const roots: string[] = [];

async function specFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-openapi-'));
  roots.push(root);
  const path = join(root, 'acme.json');
  await writeFile(path, JSON.stringify(SPEC));
  return path;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function contextWith(record: { request?: Request }): ConnectorContext {
  return {
    manifest: { id: 'acme', name: 'Acme' } as never,
    provider: { signal: new AbortController().signal } as never,
    async authorize(request) {
      // Core attaches auth here; the connector never sees a raw credential.
      const authorised = new Request(request, { headers: new Headers(request.headers) });
      authorised.headers.set('x-api-key', 'from-the-credential-store');
      record.request = authorised;
      return authorised;
    },
  };
}

describe('generating capabilities from a spec', () => {
  test('one capability per operation, named by operationId', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
    });

    const names = (await connector.discover(CONTEXT)).map((c) => c.name).sort();
    expect(names).toEqual(['cancelPayment', 'createPayment', 'getAccount', 'listAccounts']);
  });

  test('parameters across path, query, and body merge into one input schema', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
    });

    const capabilities = await connector.discover(CONTEXT);
    const getAccount = capabilities.find((c) => c.name === 'getAccount');
    const createPayment = capabilities.find((c) => c.name === 'createPayment');

    expect(Object.keys((getAccount?.inputSchema['properties'] ?? {}) as object)).toContain('accountId');
    const paymentProps = Object.keys((createPayment?.inputSchema['properties'] ?? {}) as object);
    expect(paymentProps).toContain('amount');
    expect(paymentProps).toContain('to');
  });

  test('the HTTP method decides the bundle, with no curation', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
    });

    const byName = new Map((await connector.discover(CONTEXT)).map((c) => [c.name, c.bundle]));

    // GET and HEAD are the only verbs reliably safe to grant by default.
    expect(byName.get('listAccounts')).toBe('read');
    expect(byName.get('getAccount')).toBe('read');
    expect(byName.get('createPayment')).toBe('write');
    expect(byName.get('cancelPayment')).toBe('write');
  });
});

describe('filtering keeps the tool list usable', () => {
  test('include globs match operationId, path, or tag', async () => {
    const path = await specFile();

    const byTag = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: path,
      include: ['Payment'],
    });
    expect((await byTag.discover(CONTEXT)).map((c) => c.name).sort()).toEqual([
      'cancelPayment',
      'createPayment',
    ]);

    const byOperation = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: path,
      include: ['*Account*'],
    });
    expect((await byOperation.discover(CONTEXT)).map((c) => c.name).sort()).toEqual([
      'getAccount',
      'listAccounts',
    ]);
  });

  test('exclude wins over include', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      include: ['*Payment*'],
      exclude: ['cancelPayment'],
    });

    expect((await connector.discover(CONTEXT)).map((c) => c.name)).toEqual(['createPayment']);
  });

  test('glob matching is anchored, so a pattern cannot over-match', () => {
    expect(globMatches('listAccounts', 'listAccounts')).toBe(true);
    expect(globMatches('list*', 'listAccounts')).toBe(true);
    expect(globMatches('*Account*', 'getAccount')).toBe(true);
    expect(globMatches('Account', 'getAccount')).toBe(false);
    expect(globMatches('list*', 'delistAccounts')).toBe(false);
  });
});

describe('building the request', () => {
  test('places path, query, and body arguments where the spec says', async () => {
    const record: { request?: Request } = {};
    let seen: Request | undefined;

    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      fetch: (async (request: Request) => {
        seen = request;
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof globalThis.fetch,
    });

    const capabilities = await connector.discover(CONTEXT);
    const getAccount = capabilities.find((c) => c.name === 'getAccount')!;

    await connector.invoke(getAccount, { accountId: 'acc_123', limit: 5 }, contextWith(record));

    expect(seen?.method).toBe('GET');
    expect(new URL(seen!.url).pathname).toBe('/v1/accounts/acc_123');
    // Auth was attached by core, not by the connector.
    expect(seen?.headers.get('x-api-key')).toBe('from-the-credential-store');
  });

  test('sends a JSON body for a mutating operation', async () => {
    let seen: Request | undefined;

    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      fetch: (async (request: Request) => {
        seen = request;
        return new Response('{"id":"pay_1"}');
      }) as unknown as typeof globalThis.fetch,
    });

    const createPayment = (await connector.discover(CONTEXT)).find(
      (c) => c.name === 'createPayment',
    )!;

    await connector.invoke(createPayment, { amount: 10, to: 'NL00BUNQ' }, contextWith({}));

    expect(seen?.method).toBe('POST');
    expect(seen?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(await seen!.text())).toEqual({ amount: 10, to: 'NL00BUNQ' });
  });

  test('a missing path parameter fails before the request goes out', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      fetch: (async () => new Response('should not be reached')) as never,
    });

    const getAccount = (await connector.discover(CONTEXT)).find((c) => c.name === 'getAccount')!;

    await expect(connector.invoke(getAccount, {}, contextWith({}))).rejects.toThrow(
      /Missing path parameter "accountId"/,
    );
  });

  test('an upstream error becomes a tool error, carrying the status', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      fetch: (async () =>
        new Response('{"error":"nope"}', { status: 403, statusText: 'Forbidden' })) as never,
    });

    const listAccounts = (await connector.discover(CONTEXT)).find(
      (c) => c.name === 'listAccounts',
    )!;

    const result = await connector.invoke(listAccounts, {}, contextWith({}));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('403');
  });
});

describe('what comes back', () => {
  /** Answer with whatever the vendor would, and hand back the parsed result. */
  const answering = async (response: Response, operation = 'cancelPayment') => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      fetch: (async () => response) as never,
    });

    const capability = (await connector.discover(CONTEXT)).find((c) => c.name === operation)!;
    return connector.invoke(capability, {}, contextWith({}));
  };

  test('a 204 becomes a receipt an agent can read', async () => {
    // The status *is* the vendor's confirmation, but an empty string does not
    // read as one: it is indistinguishable from a call that did nothing, and
    // settling it used to cost a second, read-only call.
    const result = await answering(new Response(null, { status: 204, statusText: 'No Content' }));

    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      status: 204,
    });
  });

  test('a whitespace-only body is not a confirmation either', async () => {
    const result = await answering(new Response('\n', { status: 200 }));

    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      status: 200,
    });
  });

  test('a body that came back is passed through untouched', async () => {
    // Including `{}`, which is a real answer rather than an absent one — the
    // receipt is for the case where there is nothing to pass through at all.
    const empty = await answering(new Response('{}', { status: 200 }), 'listAccounts');
    expect((empty.content[0] as { text: string }).text).toBe('{}');

    const body = await answering(new Response('{"id":"pay_1"}', { status: 201 }), 'createPayment');
    expect((body.content[0] as { text: string }).text).toBe('{"id":"pay_1"}');
  });
});

describe('caching what invocation needs', () => {
  test('a capability carries enough to rebuild the request without the spec', async () => {
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
    });

    const capability = (await connector.discover(CONTEXT)).find((c) => c.name === 'getAccount')!;

    // This is what lands in the database cache, so a cold instance can serve
    // without re-reading the OpenAPI document.
    expect(capability.target).toMatchObject({ path: '/accounts/{accountId}', method: 'get' });
    expect(Array.isArray(capability.target?.['mapper'])).toBe(true);
    expect(JSON.parse(JSON.stringify(capability.target))).toEqual(capability.target);
  });
});

describe('the bundle rule', () => {
  test.each([
    ['get', 'read'],
    ['head', 'read'],
    ['GET', 'read'],
    ['post', 'write'],
    ['put', 'write'],
    ['patch', 'write'],
    ['delete', 'write'],
  ])('%s → %s', (method, expected) => {
    expect(bundleForMethod(method)).toBe(expected);
  });
});

describe('names are shortened against the provider', () => {
  // Google's operationIds are already namespaced — `gmail.users.labels.list` —
  // so without this the wire name is `gmail_gmail_users_labels_list`. Same fix
  // and same reason as the Notion tools named `notion-*`.
  const prefixed = {
    ...SPEC,
    paths: {
      '/labels': {
        get: { operationId: 'acme.labels.list', responses: { '200': { description: 'ok' } } },
      },
    },
  };

  async function connectorFor(): Promise<ReturnType<typeof createHttpConnector>> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-openapi-'));
    roots.push(root);
    const path = join(root, 'prefixed.json');
    await writeFile(path, JSON.stringify(prefixed));
    return createHttpConnector({ baseUrl: 'https://api.acme.test/v1', openapi: path });
  }

  test('a redundant provider prefix is dropped', async () => {
    const capabilities = await (await connectorFor()).discover(CONTEXT);
    expect(capabilities.map((c) => c.name)).toEqual(['labels.list']);
  });

  test('the upstream name is kept for the call itself', async () => {
    // Shortening changes how a capability is addressed in policy and audit. It
    // must never change which operation is invoked.
    const [capability] = await (await connectorFor()).discover(CONTEXT);
    expect(capability?.target?.['path']).toBe('/labels');
  });

  test('an unrelated provider id leaves the name alone', async () => {
    const capabilities = await (await connectorFor()).discover({
      manifest: { id: 'other' },
    } as never);
    expect(capabilities.map((c) => c.name)).toEqual(['acme.labels.list']);
  });
});

describe('array query parameters are repeated, not joined', () => {
  // OpenAPI's default for a query parameter is `style: form, explode: true` —
  // one occurrence per element. Joining them produced a single value like
  // `From,Subject`, which Gmail matched against no header name at all: the
  // response came back with an empty header list and no error to explain it.
  test('each element becomes its own occurrence', async () => {
    const record: { request?: Request } = {};
    const connector = createHttpConnector({
      baseUrl: 'https://api.acme.test/v1',
      openapi: await specFile(),
      fetch: (async (request: Request) => {
        record.request = request;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const context = contextWith(record);
    const capabilities = await connector.discover(CONTEXT);
    const listAccounts = capabilities.find((c) => c.name === 'listAccounts')!;

    await connector.invoke(listAccounts, { status: ['open', 'closed'] }, context);

    const url = new URL(record.request!.url);
    expect(url.searchParams.getAll('status')).toEqual(['open', 'closed']);
    expect(url.search).not.toContain('open%2Cclosed');
  });
});
