import { describe, expect, test } from 'bun:test';
import { controlRoutes } from './routes.ts';
import type { ControlDeps } from './routes.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * Storing an account somebody just authorised.
 *
 * The api runs the OAuth exchange — it holds the broker client secrets, it is
 * the only party with a browser session, and it is where the callback lands.
 * What reaches here is the result: a credential, and the row that says which
 * account it is.
 *
 * So this route is the *end* of connecting rather than the whole of it, and the
 * shape reflects that. It never opens a browser, never talks to a vendor, and
 * never decides whether the person was allowed to authorise anything.
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
    agentMayManage: async () => true,
    storeConnection: async () => ({ connection: 'notion.con1', account: 'ada@example.com' }),
    ...over,
  };
}

const post = (body: unknown) =>
  new Request('https://runtime.internal/v1/connections', {
    method: 'POST',
    headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const VALID = {
  provider: 'notion',
  account: 'ada@example.com',
  credential: 'secret-refresh-token',
  profile: 'personal',
};

describe('storing an authorised account', () => {
  test('writes it and says what it is called', async () => {
    const response = await controlRoutes(post(VALID), deps());
    expect(response.status).toBe(201);
    expect((await response.json() as { connection: string }).connection).toBe('notion.con1');
  });

  test('needs admin and the scope, like every other widening act', async () => {
    for (const caller of [{ ...ADMIN, role: 'editor' as const }, { ...ADMIN, scopes: [] }]) {
      const response = await controlRoutes(
        post(VALID),
        deps({ verifier: { async verify() { return caller; } } }),
      );
      expect(response.status).toBe(403);
    }
  });

  test('a profile closed to agents refuses', async () => {
    const response = await controlRoutes(post(VALID), deps({ agentMayManage: async () => false }));
    expect(response.status).toBe(403);
  });

  test('refuses a body missing anything it cannot invent', async () => {
    for (const missing of ['provider', 'account', 'credential', 'profile']) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[missing];
      expect((await controlRoutes(post(body), deps())).status, missing).toBe(400);
    }
  });

  test('refuses a provider id the manifest format would not accept', async () => {
    for (const bad of ['Notion', 'no-tion', '../escape', '']) {
      const response = await controlRoutes(post({ ...VALID, provider: bad }), deps());
      expect(response.status, bad).toBe(400);
    }
  });

  test('never returns the credential it was given', async () => {
    // The one thing this route must not echo. A response body reaches a log, a
    // proxy and whatever the api does with it next.
    const response = await controlRoutes(post(VALID), deps());
    expect(await response.text()).not.toContain('secret-refresh-token');
  });

  test('never returns the credential in a refusal either', async () => {
    // The easier one to get wrong: an error that echoes the request.
    const response = await controlRoutes(
      post({ ...VALID, provider: 'Bad Provider' }),
      deps(),
    );
    expect(await response.text()).not.toContain('secret-refresh-token');
  });

  test('stores it in the workspace the assertion named', async () => {
    const seen: string[] = [];
    await controlRoutes(
      post(VALID),
      deps({
        storeConnection: async (_p, _a, _c, _pr, env) => {
          seen.push(env['LANES_LINK_HOME'] ?? '');
          return { connection: 'notion.con1', account: 'ada@example.com' };
        },
      }),
    );
    expect(seen).toEqual(['lanes://ws-aaa']);
  });
});
