import { describe, expect, test } from 'bun:test';
import { BearerAuthenticator } from '#auth';
import { allocatePort, wireProfiles, HARNESS_SUBJECT, TEST_TOKEN } from '../harness.ts';
import { createRequestHandler, MCP_PATH, serve } from '../index.ts';
import { ATTACHMENTS_PATH } from '../attachments.ts';
import { ANY_ORIGIN, corsAware } from '../cors.ts';
import { Generations } from '../generations.ts';
import { silentLogger } from '../logging.ts';
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
/**
 * **The MCP bearer, because that is now the only credential here** (ADR-079).
 *
 * There is no dashboard token in this file any more. `deployed()` hands the
 * read deps the same `BearerAuthenticator` it hands `createRequestHandler`, so
 * every case below presents the credential a client presents to `/mcp` and the
 * profiles it reaches are the ones `profilesFor` resolved.
 */
const READS = TEST_TOKEN;

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

/**
 * The placeholder `deployed()` swaps for the endpoint's real authenticator.
 *
 * Compared by identity, so a test that supplies its own `authenticate` — to
 * make it throw, or to count the calls — keeps it. Without the sentinel the
 * substitution would silently overwrite the thing under test.
 */
const STUB: ReadDeps['authenticate'] = async () => ({ ok: false, reason: 'invalid' });

function readDeps(overrides: Partial<ReadDeps> = {}): ReadDeps {
  return {
    workspace: 'cloud',
    profiles: () => new Map(),
    audit: AUDIT,
    connections: async () => [],
    // Replaced by `deployed()` with the real authenticator. A test that wants
    // to state the outcome itself passes its own and keeps it — see `STUB`.
    authenticate: STUB,
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

  // **One authenticator, both surfaces**, which is what `endpoint.ts` does and
  // what this file exists to hold. Building two would let the read surface and
  // `/mcp` drift into two answers about who a bearer belongs to — the drift
  // ADR-079 closes.
  const authenticator = new BearerAuthenticator({
    profile: 'personal',
    tokens: async () => [{ id: 'tok1', subject: HARNESS_SUBJECT, ref: 'tokens/tok1' }],
    credentials,
    profilesFor: async () => ['personal'],
  });

  const handler = createRequestHandler({
    generations: new Generations(
      { profiles, close: nothing },
      async () => ({ profiles, close: nothing }),
      { primary: 'personal', log },
    ),
    primary: 'personal',
    authenticator,
    log,
    meterUnauthenticated: true,
    ...(read
      ? {
          read:
            read.authenticate === STUB
              ? { ...read, authenticate: (h: string | null | undefined) => authenticator.authenticate(h) }
              : read,
        }
      : {}),
  });

  return corsAware((request) => handler.fetch(request), [MCP_PATH, ATTACHMENTS_PATH], {
    allowedOrigins: [ANY_ORIGIN],
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://endpoint.example${path}`, { headers });
}

const signedIn = (path: string, origin = ORIGIN): Request =>
  get(path, { origin, authorization: `Bearer ${READS}` });

describe('one origin, named, never a wildcard', () => {
  test('the dashboard origin is echoed exactly', async () => {
    const response = await deployed(readDeps())(signedIn('/state'));

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  test('the surrounding policy is a wildcard and this surface is still not', async () => {
    // The test that fails the day somebody adds `/state` to the `credentialed`
    // array in `serve()`. `corsAware` would then overwrite the echo with `*`,
    // and every test driving `readRoutes` directly would still pass.
    const response = await deployed(readDeps())(signedIn('/state'));

    expect(response.headers.get('access-control-allow-origin')).not.toBe(ANY_ORIGIN);
  });

  test('another origin is refused, and told nothing', async () => {
    const response = await deployed(readDeps())(signedIn('/state', HOSTILE));

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    // On the refusal too: without it a cache between here and the page can
    // serve one origin's answer to another.
    expect(response.headers.get('vary')).toBe('Origin');
  });
});

describe('the same credential /mcp takes', () => {
  test('the MCP bearer opens the read surface', async () => {
    // **The inversion this release is.** This assertion used to be its own
    // opposite: the read surface had a credential of its own, and presenting
    // the MCP bearer to it was a `401`. Two credentials meant two sets of
    // rules, and only one of them ever asked who was holding it (ADR-079).
    const response = await deployed(readDeps())(signedIn('/state'));

    expect(response.status).toBe(200);
  });

  test('a bearer no token row matches is refused', async () => {
    const response = await deployed(readDeps())(
      get('/state', { origin: ORIGIN, authorization: 'Bearer llk_not_a_real_token' }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', signIn: true });
  });

  test('no credential at all is refused before the store is asked anything', async () => {
    let reads = 0;
    const response = await deployed(
      readDeps({
        authenticate: async () => {
          reads += 1;
          return { ok: false, reason: 'invalid' };
        },
      }),
    )(get('/state', { origin: ORIGIN }));

    expect(response.status).toBe(401);
    // On a deployed workspace resolving a bearer is a Secret Manager round
    // trip, so a stranger sending no header must not be able to provoke one.
    // `deployed()` replaces `authenticate`, so the counter proves the *header*
    // check short-circuits rather than proving anything about this stub.
    expect(reads).toBe(0);
  });
});

describe('never ambient', () => {
  test('credentials are never allowed, on any answer', async () => {
    const answers = await Promise.all([
      deployed(readDeps())(signedIn('/state')),
      deployed(readDeps())(get('/state', { origin: ORIGIN })),
      deployed(readDeps())(signedIn('/state', HOSTILE)),
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

describe('the control plane is still unreachable', () => {
  // The block was `reads only, ever` until ADR-069 gave a pairing token the
  // owner's own data. What it asserted about *these* paths did not change and
  // must not: `/state` and `/audit` are reads, and everything the control plane
  // owns is unreachable from here in either direction. `read/data.test.ts`
  // holds the other half.
  test('a write to a read path is not found rather than not allowed', async () => {
    const response = await deployed(readDeps())(
      new Request('https://endpoint.example/state', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${READS}` },
      }),
    );

    // Not 405: that would confirm a Lanes read surface is here to a caller who
    // has not presented a credential.
    expect(response.status).toBe(404);
  });

  test('nothing the control plane owns is a path here', async () => {
    // Each of these is a thing ADR-007 keeps in the CLI. None of them gained a
    // route when `/data` did, and a pairing token reaches none of them.
    for (const path of ['/connections', '/profiles', '/policy', '/tokens', '/config']) {
      const response = await deployed(readDeps())(signedIn(path));
      expect(response.status).toBe(404);
    }
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
        tokens: async () => [{ id: 'tok1', subject: 'lanes:harness0000', ref: 'tokens/tok1' }],
        credentials,
        profilesFor: async () => ['personal'],
      }),
      log,
      host: '127.0.0.1',
      port: allocatePort(),
      read: readDeps(),
    });

    try {
      const response = await fetch(`${server.url.replace(MCP_PATH, '')}/state`, {
        headers: { authorization: `Bearer ${READS}` },
      });

      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe('nothing here reads a credential of its own', () => {
  test('an authenticator that throws is a refusal, not a 500', async () => {
    // What `readableRefs` used to buy for the pairing token, now the property
    // that matters for the only credential left: resolving a bearer reaches
    // Secret Manager, and a wrong project or an expired metadata token throws.
    // Uncaught that is a 500 on a public URL.
    const response = await deployed(
      readDeps({
        authenticate: async () => {
          throw new Error('permission denied on projects/my-project/secrets/tokens_tok1');
        },
      }),
    )(signedIn('/state'));

    expect(response.status).toBe(401);
  });
});

describe('what the endpoint says about itself', () => {
  test('a deployed bind names itself, and claims no certificate of its own', async () => {
    const response = await deployed(readDeps())(signedIn('/state'));

    expect(await response.json()).toMatchObject({
      workspace: 'cloud',
      endpoint: { kind: 'deployed', version: '0.0.0-test', certificateExpiresAt: null },
    });
  });
});
