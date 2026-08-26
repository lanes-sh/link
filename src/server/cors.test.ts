import { afterAll, describe, expect, test } from 'bun:test';
import { BearerAuthenticator } from '#auth';
import { allocatePort, startHarness, wireProfiles, TEST_TOKEN } from './harness.ts';
import { createRequestHandler, MCP_PATH } from './index.ts';
import { ATTACHMENTS_PATH } from './attachments.ts';
import { ANY_ORIGIN, corsAware } from './cors.ts';
import { Generations } from './generations.ts';
import { silentLogger } from './logging.ts';

/**
 * Who may call this endpoint from a browser.
 *
 * The loopback half is over real HTTP, because that is the half with a wrong
 * answer available: an endpoint on `127.0.0.1` must refuse a cross-origin caller
 * however the request is dressed, and the guard doing it lives in the same
 * router as the grant.
 *
 * The deployed half is a handler rather than a socket, and the reason is a
 * tradeoff worth stating. Reaching `serve`'s non-loopback branch means binding a
 * non-loopback address, which in practice means `0.0.0.0` — a listener on every
 * interface, and on macOS a firewall prompt, every time anyone runs `bun test`.
 * What that would buy over the handler is the socket alone: the request, the
 * response, the header values and the position of the preflight relative to the
 * auth gate are all exercised below.
 */

const ORIGIN = 'https://chat.example';

/** Loopback, so `serve` builds no policy at all. */
const local = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:\n    - "example.*"`,
});

afterAll(async () => {
  await local.stop();
});

/**
 * A handler wired as a deployment: no `allowedHostnames`, and a policy.
 *
 * Composed exactly as `serve()` composes it off loopback — the same wrapper over
 * the same router — so what differs from a real endpoint is the socket and
 * nothing else. `wireProfiles` is the wiring `startHarness` uses.
 */
function deployed(allowedOrigins: readonly string[]): (request: Request) => Promise<Response> {
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
  });

  return corsAware((request) => handler.fetch(request), [MCP_PATH, ATTACHMENTS_PATH], {
    allowedOrigins,
  });
}

const preflight = (path: string, origin = ORIGIN): Request =>
  new Request(`http://endpoint.example${path}`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

describe('a deployment answers a preflight', () => {
  test('without a credential, which is the only way one ever arrives', async () => {
    const response = await deployed([ANY_ORIGIN])(preflight(MCP_PATH));

    // The bug this whole file exists for: 401 here refuses every browser client
    // before it can present the credential the refusal is asking for.
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ANY_ORIGIN);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  test('for any origin, because that is what an unset allowlist means', async () => {
    // The default, and the reason there is no setup step: a deployment is
    // already reachable by anyone, and the credential is never ambient.
    const response = await deployed([ANY_ORIGIN])(preflight(MCP_PATH, 'https://unknown.example'));
    expect(response.headers.get('access-control-allow-origin')).toBe(ANY_ORIGIN);
  });

  test('and a wildcard does not claim to vary, which would poison a cache', async () => {
    const response = await deployed([ANY_ORIGIN])(preflight(MCP_PATH));
    expect(response.headers.get('vary')).toBeNull();
  });

  test('naming the headers this endpoint actually reads', async () => {
    const response = await deployed([ANY_ORIGIN])(preflight(MCP_PATH));
    const allowed = response.headers.get('access-control-allow-headers') ?? '';

    // `authorization` because the credential is one, and the envelope's two
    // because a call carrying neither is served as a 2025-era request instead.
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('mcp-method');
    expect(allowed).toContain('mcp-name');
  });

  test('and never claims credentials may be attached', async () => {
    // The one header that would make the wildcard dangerous, and with `*` the
    // specification refuses the combination anyway.
    const response = await deployed([ANY_ORIGIN])(preflight(MCP_PATH));
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('naming origins narrows it', () => {
  test('echoing a listed one, and varying so no cache crosses them', async () => {
    const response = await deployed([ORIGIN])(preflight(MCP_PATH));

    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  test('and granting nothing to one that is not listed', async () => {
    const response = await deployed([ORIGIN])(preflight(MCP_PATH, 'https://other.example'));

    // 204 rather than 403: the browser refuses on the absent header, which is
    // the mechanism CORS uses, and a distinct status would map which paths exist.
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('but never narrows discovery, which a client reads before it has anything', async () => {
    const response = await deployed([ORIGIN])(
      preflight('/.well-known/oauth-protected-resource', 'https://other.example'),
    );

    expect(response.headers.get('access-control-allow-origin')).toBe(ANY_ORIGIN);
  });
});

describe('the discovery surface needs no allowlist', () => {
  test('because it answers without a credential either way', async () => {
    const response = await deployed([])(
      preflight('/.well-known/oauth-protected-resource', 'https://anyone.example'),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    // A wildcard cannot vary, and saying it does would poison a shared cache.
    expect(response.headers.get('vary')).toBeNull();
  });

  test('and /health is in neither half, so it is granted nothing', async () => {
    const response = await deployed([ANY_ORIGIN])(preflight('/health'));
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('a real response carries the grant too', () => {
  test('including the 401, whose challenge is the whole handshake', async () => {
    const response = await deployed([ANY_ORIGIN])(
      new Request(`http://endpoint.example${MCP_PATH}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(ANY_ORIGIN);
    // Without this a browser client receives the refusal and cannot read the
    // `resource_metadata` pointer telling it what to do about it (ADR-036).
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  test('and a non-browser caller sees exactly what it saw before', async () => {
    const response = await deployed([ANY_ORIGIN])(
      new Request(`http://endpoint.example${MCP_PATH}`, { method: 'POST', body: '{}' }),
    );

    // No Origin, so nothing to grant and no header invented for it.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('www-authenticate')).toContain('realm="lanes-link"');
  });
});

describe('a loopback endpoint grants nothing, ever', () => {
  test('refusing a cross-origin preflight rather than answering it', async () => {
    const response = await fetch(`${local.server.url}`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });

    // `./rebinding.ts` has already answered this question, and answered it no:
    // a page the owner is visiting can reach 127.0.0.1, and what it would reach
    // includes the form that asks them for their token.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.status).toBe(403);
  });

  test('and a same-origin caller is unaffected', async () => {
    const response = await fetch(`${local.server.url}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(200);
  });
});
