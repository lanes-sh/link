import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BearerAuthenticator } from '#auth';
import { dataSurface, type Answer, type DataSurface } from '#cli/owner-data/index.ts';
import { openRuntime, type Runtime } from '#cli/runtime.ts';
import { profileAdd } from '#cli/commands/profile.ts';
import { allocatePort, wireProfiles, HARNESS_SUBJECT, TEST_TOKEN } from '../harness.ts';
import { createRequestHandler, MCP_PATH, serve } from '../index.ts';
import { ATTACHMENTS_PATH } from '../attachments.ts';
import { ANY_ORIGIN, corsAware } from '../cors.ts';
import { Generations } from '../generations.ts';
import { silentLogger } from '../logging.ts';
import { directPairingCredential } from './credential.ts';
import type { AuditTail, ReadDeps } from './routes.ts';

/**
 * `/data`, the surface a pairing token may write (ADR-069).
 *
 * Two halves, because two different things can break. The composed handler
 * covers the transport — methods, CORS, the credential, and the mapping from a
 * refusal to a status — with a stubbed surface, in `deployed.test.ts`'s shape
 * and for the reason it gives: driving `dataRoutes` alone would pass while
 * `corsAware` quietly overwrote its headers. The second half runs the same
 * composition over a real workspace on disk, because "the write landed where
 * the provider reads" is the failure a stubbed surface cannot see.
 *
 * Neither half binds TLS. `listener.test.ts` owns that, and it owns it over the
 * same `readRoutes` these go through.
 */

const ORIGIN = 'https://lanes.sh';
const HOSTILE = 'https://evil.example';
const PAIR_TOKEN = 'llp_a-data-pairing-token';

const AUDIT: AuditTail = { tail: async () => [] };

/** Every call recorded, so a test can assert what did and did not reach it. */
interface Spy extends DataSurface {
  readonly calls: string[];
}

function stub(overrides: Partial<DataSurface> = {}): Spy {
  const calls: string[] = [];
  const seen = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve({ ok: true, value } as Answer<T>);
  };

  return {
    calls,
    list: (options) => seen('list', [{ id: 'a', title: 'A', summary: null, updatedAt: null, tags: [options.store] }]),
    read: () => seen('read', detail()),
    content: () => seen('content', { bytes: new TextEncoder().encode('hi'), contentType: 'text/plain' }),
    create: () => seen('create', detail()),
    write: () => seen('write', detail()),
    remove: () => seen('remove', undefined),
    ...overrides,
  } as Spy;
}

function detail() {
  return {
    id: 'a',
    title: 'A',
    summary: null,
    updatedAt: null,
    tags: [],
    body: 'the document',
    readOnly: null,
    contentType: 'text/markdown',
    bytes: 12,
  };
}

function readDeps(overrides: Partial<ReadDeps> = {}): ReadDeps {
  return {
    workspace: 'cloud',
    profiles: () => new Map(),
    audit: AUDIT,
    connections: async () => [],
    credential: directPairingCredential({ read: async () => PAIR_TOKEN }),
    endpoint: { kind: 'deployed', version: '0.0.0-test', certificateExpiresAt: null },
    ...overrides,
  };
}

function deployed(read: ReadDeps): (request: Request) => Promise<Response> {
  const { profiles, credentials } = wireProfiles({
    profile: 'personal',
    port: allocatePort(),
    policy: `  allow:\n    - "example.*"`,
  });

  const nothing = () => Promise.resolve();
  const log = silentLogger();

  const handler = createRequestHandler({
    generations: new Generations(
      { profiles, close: nothing },
      async () => ({ profiles, close: nothing }),
      { primary: 'personal', log },
    ),
    primary: 'personal',
    authenticator: new BearerAuthenticator({
      profile: 'personal',
      tokens: async () => [{ id: 'tok1', subject: HARNESS_SUBJECT, ref: 'tokens/tok1' }],
      credentials,
      profilesFor: async () => ['personal'],
    }),
    log,
    meterUnauthenticated: true,
    read,
  });

  return corsAware((request) => handler.fetch(request), [MCP_PATH, ATTACHMENTS_PATH], {
    allowedOrigins: [ANY_ORIGIN],
  });
}

function send(
  path: string,
  init: { method?: string; body?: unknown; origin?: string; token?: string | null } = {},
): Request {
  const headers: Record<string, string> = { origin: init.origin ?? ORIGIN };
  const token = init.token === undefined ? PAIR_TOKEN : init.token;
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return new Request(`https://endpoint.example${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe('the credential', () => {
  test('an unpaired write is refused, and the surface is never asked', async () => {
    const surface = stub();
    const response = await deployed(readDeps({ data: surface }))(
      send('/data/memory/a?profile=personal', { method: 'PUT', body: { body: 'x' }, token: null }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unpaired', run: 'lanes link pair' });
    // The gate is above the store, so a stranger costs nothing.
    expect(surface.calls).toEqual([]);
  });

  test('the MCP bearer does not write the data surface', async () => {
    const surface = stub();
    const response = await deployed(readDeps({ data: surface }))(
      send('/data/memory/a?profile=personal', { method: 'PUT', body: { body: 'x' }, token: TEST_TOKEN }),
    );

    expect(response.status).toBe(401);
    expect(surface.calls).toEqual([]);
  });

  test('a hostile origin is refused before the credential is looked at', async () => {
    const surface = stub();
    const response = await deployed(readDeps({ data: surface }))(
      send('/data/memory?profile=personal', { origin: HOSTILE }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(surface.calls).toEqual([]);
  });
});

describe('the methods, and where they stop', () => {
  test('a preflight for a write names the methods and the header a body needs', async () => {
    const response = await deployed(readDeps({ data: stub() }))(
      new Request('https://endpoint.example/data/memory/a', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type');
    // Still never ambient. The whole safety of this surface rests on it.
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('/state did not widen with it', async () => {
    const allow = await deployed(readDeps({ data: stub() }))(
      new Request('https://endpoint.example/state', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      }),
    );

    expect(allow.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');

    const written = await deployed(readDeps({ data: stub() }))(
      send('/state', { method: 'PUT', body: { body: 'x' } }),
    );

    // Not 405, and not written: `/state` and `/audit` are reads only, still.
    expect(written.status).toBe(404);
  });

  test('an endpoint with no data surface answers /data as an unknown path', async () => {
    const response = await deployed(readDeps())(send('/data/memory?profile=personal'));

    expect(response.status).toBe(404);
  });
});

describe('what a path may name', () => {
  test('a store that is not on the list is not found', async () => {
    const surface = stub();
    const response = await deployed(readDeps({ data: surface }))(
      send('/data/credentials?profile=personal'),
    );

    expect(response.status).toBe(404);
    expect(surface.calls).toEqual([]);
  });

  test('a missing profile is not found rather than defaulted', async () => {
    const surface = stub();
    const response = await deployed(readDeps({ data: surface }))(send('/data/memory'));

    expect(response.status).toBe(404);
    // Never a default: it would write into whichever profile happened to be first.
    expect(surface.calls).toEqual([]);
  });

  test('a create names no id, and a write names one', async () => {
    const surface = stub();
    const deps = readDeps({ data: surface });

    // The route decides these, not the surface: an id is derived from the
    // document, so `POST` to one would be the caller inventing a name.
    expect((await deployed(deps)(send('/data/memory/a?profile=personal', { method: 'POST', body: { body: 'x' } }))).status).toBe(404);
    expect((await deployed(deps)(send('/data/memory?profile=personal', { method: 'PUT', body: { body: 'x' } }))).status).toBe(404);
    expect((await deployed(deps)(send('/data/memory?profile=personal', { method: 'DELETE' }))).status).toBe(404);
  });

  test('a write with no document is a bad request, and never reaches the store', async () => {
    const surface = stub();
    const response = await deployed(readDeps({ data: surface }))(
      send('/data/memory/a?profile=personal', { method: 'PUT', body: { nothing: true } }),
    );

    expect(response.status).toBe(400);
    expect(surface.calls).toEqual([]);
  });

  test('the content route belongs to assets alone', async () => {
    const surface = stub();
    const deps = readDeps({ data: surface });

    expect((await deployed(deps)(send('/data/assets/a.txt/content?profile=personal'))).status).toBe(200);
    expect((await deployed(deps)(send('/data/memory/a/content?profile=personal'))).status).toBe(404);
  });
});

describe('a refusal reaches the reader only when it is theirs to act on', () => {
  test('a rejected document carries the message, because no command fixes it', async () => {
    const surface = stub({
      write: async () =>
        ({ ok: false, refusal: { status: 400, error: 'rejected', message: 'skill: description is required' } }),
    });

    const response = await deployed(readDeps({ data: surface }))(
      send('/data/skills/a?profile=personal', { method: 'PUT', body: { body: 'x' } }),
    );

    expect(response.status).toBe(400);
    // "not paired" here would send somebody to re-run a pairing command that
    // was never the problem.
    expect(await response.json()).toMatchObject({ message: 'skill: description is required' });
  });

  test('a not-found carries no message at all', async () => {
    const surface = stub({
      read: async () => ({ ok: false, refusal: { status: 404, error: 'not_found', message: 'No memory item "a".' } }),
    });

    const response = await deployed(readDeps({ data: surface }))(send('/data/memory/a?profile=personal'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

describe('an asset is served as a file, never as this origin', () => {
  test('the bytes come back with the stored type, as an attachment, nosniff', async () => {
    const surface = stub({
      content: async () => ({
        ok: true,
        value: { bytes: new TextEncoder().encode('<script>alert(1)</script>'), contentType: 'text/html' },
      }),
    });

    const response = await deployed(readDeps({ data: surface }))(
      send('/data/assets/page.html/content?profile=personal'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    // On a deployed bind this origin also serves `/mcp`, `/authorize` and the
    // discovery documents. Inline would run that script in the endpoint's own
    // origin, so both headers are unconditional.
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('a deployment-only grant stays one', () => {
  test('a loopback bind does not serve /data on the MCP port', async () => {
    const { profiles, credentials } = wireProfiles({
      profile: 'personal',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"`,
    });

    const nothing = () => Promise.resolve();
    const log = silentLogger();

    const server = serve({
      generations: new Generations(
        { profiles, close: nothing },
        async () => ({ profiles, close: nothing }),
        { primary: 'personal', log },
      ),
      primary: 'personal',
      authenticator: new BearerAuthenticator({
        profile: 'personal',
        tokens: async () => [{ id: 'tok1', subject: HARNESS_SUBJECT, ref: 'tokens/tok1' }],
        credentials,
        profilesFor: async () => ['personal'],
      }),
      log,
      host: '127.0.0.1',
      port: allocatePort(),
      read: readDeps({ data: stub() }),
    });

    try {
      const response = await fetch(
        `${server.url.replace(MCP_PATH, '')}/data/memory?profile=personal`,
        { method: 'PUT', headers: { authorization: `Bearer ${PAIR_TOKEN}` } },
      );

      // `serve()` discards `read` on loopback, so the write surface is not on
      // the MCP port either. This is what keeps ADR-039's refusal intact.
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe('over the real composition, against a real workspace', () => {
  let home: string;
  let runtime: Runtime;
  let handler: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'lanes-data-http-'));
    process.env['LANES_LINK_HOME'] = home;

    const write = process.stdout.write.bind(process.stdout);
    try {
      (process.stdout as unknown as { write: () => boolean }).write = (): boolean => true;
      await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });
    } finally {
      (process.stdout as unknown as { write: typeof write }).write = write;
    }

    runtime = await openRuntime({ profile: 'personal', target: 'local' });
    handler = deployed(
      readDeps({ data: dataSurface(() => new Map([['personal', runtime]])) }),
    );
  });

  afterAll(async () => {
    await runtime?.close();
    delete process.env['LANES_LINK_HOME'];
    await rm(home, { recursive: true, force: true });
  });

  test('a write over the route lands where the provider reads it', async () => {
    const document = '---\ntitle: Over the wire\n---\n\nThe body.';

    const written = await handler(
      send('/data/memory/over-the-wire?profile=personal', { method: 'PUT', body: { body: document } }),
    );
    expect(written.status).toBe(200);

    // Read back through the store the provider reads, not through the route
    // that wrote it, so this cannot pass on a surface talking to itself.
    const { memoryStorage } = await import('#providers/owner.ts');
    const { storeFor } = await import('#cli/owner-data/stores.ts');
    const scoped = storeFor(runtime, 'memory');
    if (!scoped.ok) throw new Error(scoped.refusal.message);

    const entry = await memoryStorage.read(scoped.value.store, 'over-the-wire');
    expect(entry?.title).toBe('Over the wire');
  });

  test('the write it made is in the audit log, without the document', async () => {
    await handler(
      send('/data/memory/logged-over-http?profile=personal', {
        method: 'PUT',
        body: { body: '---\ntitle: Logged\n---\n\nSecret sentence.' },
      }),
    );

    const events = await runtime.audit.tail({ limit: 50 });
    const row = events.find(
      (event) => event.capability === 'memory.write' && event.arguments['id'] === 'logged-over-http',
    );

    expect(row?.principal).toBe('lanes:dashboard');
    expect(JSON.stringify(row?.arguments)).not.toContain('Secret sentence');
  });

  test('a listing and a delete round-trip', async () => {
    await handler(
      send('/data/tasks/a-task?profile=personal', {
        method: 'PUT',
        body: { body: '---\ntitle: A task\nstatus: open\n---\n\nDo it.' },
      }),
    );

    const listed = await handler(send('/data/tasks?profile=personal'));
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { items: { id: string }[] }).items.map((one) => one.id),
    ).toContain('a-task');

    expect((await handler(send('/data/tasks/a-task?profile=personal', { method: 'DELETE' }))).status).toBe(200);
    expect((await handler(send('/data/tasks/a-task?profile=personal'))).status).toBe(404);
  });

  test('a profile this endpoint does not serve is not found', async () => {
    expect((await handler(send('/data/memory?profile=work'))).status).toBe(404);
  });

  test('every write to the vault is refused, and told nothing', async () => {
    for (const attempt of [
      send('/data/vault/api_key?profile=personal', { method: 'PUT', body: { body: 'x' } }),
      send('/data/vault/api_key?profile=personal', { method: 'DELETE' }),
      send('/data/vault?profile=personal', { method: 'POST', body: { body: 'x' } }),
    ]) {
      const response = await handler(attempt);
      // The same body an unknown path gets. A distinguishable refusal would
      // confirm the shape of what is here to a page that is not the dashboard.
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  test('a vault listing carries no value under any key', async () => {
    await runtime.vault.put('lan1', { id: 'api_key', value: 'a-secret-value', description: 'A key' });

    const response = await handler(send('/data/vault?profile=personal'));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('a-secret-value');
  });
});
