import { describe, expect, test } from 'bun:test';
import { isControlPath, controlRoutes, type ControlDeps } from './routes.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * The control surface as the endpoint's own router serves it.
 *
 * It used to be a service of its own, on the reasoning that a managed endpoint
 * has to be publicly reachable (ADR-018: no MCP client can mint a Google
 * identity token) and so the control plane needed a separate, IAM-locked
 * process. That is true only if a client connects *to the endpoint*, and it
 * does not: `api.lanes.sh` is the single public surface and this runtime is
 * `--no-allow-unauthenticated`.
 *
 * So control is mounted here, exactly as ADR-064 mounts `/state` and `/audit` —
 * its own credential, never through `options.authenticator`, and only what
 * `isControlPath` matched is handed over.
 *
 * The property that got *stronger* by merging: the router already resolved a
 * workspace before this runs, and the assertion names one. Two independent
 * statements of which tenant this is, and a mismatch is refused. The separate
 * service had only the assertion.
 */

const ADMIN: ControlAssertion = {
  subject: 'lanes:abc123',
  workspace: 'ws-aaa',
  role: 'admin',
  scopes: ['link:admin'],
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function deps(over: Partial<ControlDeps> = {}): ControlDeps {
  return {
    workspace: 'ws-aaa',
    verifier: { async verify() { return ADMIN; } },
    log: silent,
    readers: {
      async connections() { return []; },
      async profiles() { return { profiles: [], unreadable: [] }; },
    },
    ...over,
  };
}

const get = (path: string) =>
  new Request(`https://runtime.internal${path}`, {
    headers: { authorization: 'Bearer a.b.c' },
  });

describe('which paths the router hands over', () => {
  test('claims its own, and nothing else', () => {
    expect(isControlPath('/v1/profiles')).toBe(true);
    expect(isControlPath('/v1/connections')).toBe(true);
  });

  test('never claims the endpoint own routes', () => {
    // A wider hand-off would swallow `/mcp`, which is the failure the read
    // surface's own comment warns about.
    for (const path of ['/mcp', '/health', '/reload', '/state', '/audit', '/authorize', '/token']) {
      expect(isControlPath(path), path).toBe(false);
    }
  });
});

describe('the workspace the router resolved, and the one the assertion names', () => {
  test('serves the request when they agree', async () => {
    const response = await controlRoutes(get('/v1/profiles'), deps());
    expect(response.status).toBe(200);
  });

  test('refuses when they disagree', async () => {
    // A valid assertion for one workspace, arriving at another's runtime. The
    // merge is what makes this checkable at all.
    const response = await controlRoutes(get('/v1/profiles'), deps({ workspace: 'ws-bbb' }));
    expect(response.status).toBe(404);
  });

  test('refuses a disagreement identically to an unknown path', async () => {
    // Probing must not be an oracle: which of the two failed is the log's
    // business, not the caller's.
    const mismatch = await controlRoutes(get('/v1/profiles'), deps({ workspace: 'ws-bbb' }));
    const unknown = await controlRoutes(get('/v1/nope'), deps());

    expect(mismatch.status).toBe(unknown.status);
    expect(await mismatch.text()).toBe(await unknown.text());
  });

  test('reads the workspace the assertion named, not the router one', async () => {
    // They agree by the time a reader runs, so either would work here — and
    // the assertion is the one that must be authoritative, because it is the
    // signed statement rather than a routing artefact.
    const roots: string[] = [];
    await controlRoutes(
      get('/v1/connections'),
      deps({
        readers: {
          async connections(root) { roots.push(root); return []; },
          async profiles() { return { profiles: [], unreadable: [] }; },
        },
      }),
    );

    expect(roots).toEqual(['lanes://ws-aaa']);
  });
});

describe('the credential', () => {
  test('is refused when absent', async () => {
    const response = await controlRoutes(
      new Request('https://runtime.internal/v1/profiles'),
      deps(),
    );
    expect(response.status).toBe(401);
  });

  test('is refused when it does not verify', async () => {
    const response = await controlRoutes(
      get('/v1/profiles'),
      deps({ verifier: { async verify() { return null; } } }),
    );
    expect(response.status).toBe(401);
  });
});
