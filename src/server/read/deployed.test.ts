import { describe, expect, test } from 'bun:test';
import { BearerAuthenticator } from '#auth';
import { allocatePort, wireProfiles, TEST_TOKEN } from '../harness.ts';
import { createRequestHandler, MCP_PATH, serve } from '../index.ts';
import { ATTACHMENTS_PATH } from '../attachments.ts';
import { ANY_ORIGIN, corsAware } from '../cors.ts';
import { Generations } from '../generations.ts';
import { silentLogger } from '../logging.ts';
import { cachedPairingCredential, directPairingCredential } from './credential.ts';
import type { AuditTail, ReadDeps } from './routes.ts';

/**
 * The read surface on a deployed endpoint (ADR-064).
 *
 * A handler rather than a socket, for the tradeoff `cors.test.ts` states and
 * which applies here with even more force: reaching `serve()`'s non-loopback
 * branch means binding `0.0.0.0` and a macOS firewall prompt on every
 * `bun test`, and what it would buy is the socket — where on loopback TLS was
 * the thing under test, here the platform terminates it.
 *
 * But the *composition* is the real one. Every case below runs through
 * `corsAware` wrapping `createRequestHandler`, exactly as `serve()` composes
 * them off loopback, and the CORS policy handed in is the deployment default of
 * `['*']`. Driving bare `readRoutes` would pass while `corsAware` quietly
 * overwrote its headers, which is the single most likely way this regresses.
 */

const ORIGIN = 'https://lanes.sh';
const HOSTILE = 'https://evil.example';
const PAIR_TOKEN = 'llp_a-deployed-pairing-token';

const AUDIT: AuditTail = {
  tail: async () => [
    {
      id: 'evt_1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      profile: 'personal',
      principal: 'lanes:HER',
      provider: 'lanes_memory',
      capability: 'lanes_memory.search',
      arguments: {},
      authorization: 'allowed',
      status: 'ok',
      durationMs: 42,
    },
  ],
};

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

/**
 * A handler wired as a deployment, with the read surface on.
 *
 * `allowedOrigins: [ANY_ORIGIN]` is deliberately the hostile setting for the
 * assertion in "one origin, named": the surrounding policy is a wildcard, and
 * the read routes must still answer with a named origin.
 */
function deployed(read: ReadDeps | undefined): (request: Request) => Promise<Response> {
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
      tokenRef: 'profile/token',
      credentials,
    }),
    log,
    meterUnauthenticated: true,
    ...(read ? { read } : {}),
  });

  return corsAware((request) => handler.fetch(request), [MCP_PATH, ATTACHMENTS_PATH], {
    allowedOrigins: [ANY_ORIGIN],
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://endpoint.example${path}`, { headers });
}

const paired = (path: string, origin = ORIGIN): Request =>
  get(path, { origin, authorization: `Bearer ${PAIR_TOKEN}` });

describe('one origin, named, never a wildcard', () => {
  test('the dashboard origin is echoed exactly', async () => {
    const response = await deployed(readDeps())(paired('/state'));

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  test('the surrounding policy is a wildcard and this surface is still not', async () => {
    // The test that fails the day somebody adds `/state` to the `credentialed`
    // array in `serve()`. `corsAware` would then overwrite the echo with `*`,
    // and every test driving `readRoutes` directly would still pass.
    const response = await deployed(readDeps())(paired('/state'));

    expect(response.headers.get('access-control-allow-origin')).not.toBe(ANY_ORIGIN);
  });

  test('another origin is refused, and told nothing', async () => {
    const response = await deployed(readDeps())(paired('/state', HOSTILE));

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    // On the refusal too: without it a cache between here and the page can
    // serve one origin's answer to another.
    expect(response.headers.get('vary')).toBe('Origin');
  });
});

describe('a credential that cannot call a tool', () => {
  test('the MCP bearer does not open the read surface', async () => {
    const response = await deployed(readDeps())(
      get('/state', { origin: ORIGIN, authorization: `Bearer ${TEST_TOKEN}` }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unpaired', run: 'lanes link pair' });
  });

  test('the pairing token does not open the endpoint', async () => {
    const response = await deployed(readDeps())(
      new Request(`https://endpoint.example${MCP_PATH}`, {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${PAIR_TOKEN}` },
      }),
    );

    // The pair a single shared `authenticate()` would silently collapse.
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).not.toBeNull();
  });

  test('no credential at all is refused before the store is asked anything', async () => {
    let reads = 0;
    const response = await deployed(
      readDeps({
        credential: directPairingCredential({
          read: async () => {
            reads += 1;
            return PAIR_TOKEN;
          },
        }),
      }),
    )(get('/state', { origin: ORIGIN }));

    expect(response.status).toBe(401);
    // On a deployed workspace a store read is a Secret Manager round trip, so
    // a stranger sending no header must not be able to provoke one.
    expect(reads).toBe(0);
  });
});

describe('never ambient', () => {
  test('credentials are never allowed, on any answer', async () => {
    const answers = await Promise.all([
      deployed(readDeps())(paired('/state')),
      deployed(readDeps())(get('/state', { origin: ORIGIN })),
      deployed(readDeps())(paired('/state', HOSTILE)),
      deployed(readDeps())(
        new Request('https://endpoint.example/state', {
          method: 'OPTIONS',
          headers: { origin: ORIGIN },
        }),
      ),
    ]);

    for (const answer of answers) {
      expect(answer.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});

describe('reads only, ever', () => {
  test('a write to a read path is not found rather than not allowed', async () => {
    const response = await deployed(readDeps())(
      new Request('https://endpoint.example/state', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${PAIR_TOKEN}` },
      }),
    );

    // Not 405: that would confirm a Lanes read surface is here to a caller who
    // has not presented a credential.
    expect(response.status).toBe(404);
  });

  test('the surface is exactly two paths', async () => {
    const response = await deployed(readDeps())(paired('/connections'));

    expect(response.status).toBe(404);
  });
});

describe('a deployment-only grant stays one', () => {
  test('a loopback bind does not serve the read routes', async () => {
    // What stops this becoming the thing ADR-039 refuses. `serve()` discards
    // `read` on loopback exactly as it discards `cors`, and the TLS listener on
    // the port above is what serves a paired local workspace instead.
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
        tokenRef: 'profile/token',
        credentials,
      }),
      log,
      host: '127.0.0.1',
      port: allocatePort(),
      read: readDeps(),
    });

    try {
      const response = await fetch(`${server.url.replace(MCP_PATH, '')}/state`, {
        headers: { authorization: `Bearer ${PAIR_TOKEN}` },
      });

      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe('the never-paired workspace', () => {
  test('a secret with no version is unpaired, not an error', async () => {
    // What `readableRefs` buys. A bound secret with no version answers 404 and
    // reads back as null; unbound it would be a 403 the adapter throws on.
    const response = await deployed(
      readDeps({ credential: cachedPairingCredential({ read: async () => null }) }),
    )(paired('/state'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unpaired', run: 'lanes link pair' });
  });

  test('a store that throws is a refusal, not a 500', async () => {
    // The other half. Even with the binding, a wrong project or an expired
    // metadata token still throws — and uncaught that is a 500 on a public URL.
    const response = await deployed(
      readDeps({
        credential: cachedPairingCredential({
          read: async () => {
            throw new Error('permission denied on projects/my-project/secrets/pair_token');
          },
        }),
      }),
    )(paired('/state'));

    expect(response.status).toBe(401);
  });
});

describe('what the endpoint says about itself', () => {
  test('a deployed bind names itself, and claims no certificate of its own', async () => {
    const response = await deployed(readDeps())(paired('/state'));

    expect(await response.json()).toMatchObject({
      workspace: 'cloud',
      endpoint: { kind: 'deployed', version: '0.0.0-test', certificateExpiresAt: null },
    });
  });
});
