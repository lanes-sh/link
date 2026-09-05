import { describe, expect, test } from 'bun:test';
import { createControlRoutes } from './routes.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * The HTTP surface, and what it refuses.
 *
 * The readers are injected here and tested where they live: what this file
 * covers is the gate. Every route reaches configuration for exactly one
 * workspace, and which one is decided by a signed statement rather than by
 * anything the caller wrote — so the assertions worth making are about who is
 * turned away, and about the root the readers were handed.
 */

const ADMIN: ControlAssertion = {
  subject: 'lanes:abc123',
  workspace: 'ws-aaa',
  role: 'admin',
  scopes: ['link:admin'],
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function routes(verified: ControlAssertion | null = ADMIN) {
  const roots: string[] = [];
  const handler = createControlRoutes({
    verifier: { async verify() { return verified; } },
    log: silent,
    readers: {
      async connections(root) {
        roots.push(root);
        return [
          {
            key: 'gmail.con1',
            provider: 'gmail',
            account: 'someone@example.com',
            label: null,
            builtIn: false,
            grantedTo: ['personal'],
          },
        ];
      },
      async profiles(root) {
        roots.push(root);
        return { profiles: [{ name: 'personal', grants: 1, members: 1 }], unreadable: [] };
      },
    },
  });
  return { handler, roots };
}

const get = (path: string, token = 'a.b.c') =>
  new Request(`https://control.example.com${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('the gate', () => {
  test('refuses a request with no credential', async () => {
    const response = await routes().handler.fetch(
      new Request('https://control.example.com/v1/connections'),
    );
    expect(response.status).toBe(401);
  });

  test('refuses a credential that does not verify', async () => {
    expect((await routes(null).handler.fetch(get('/v1/connections'))).status).toBe(401);
  });

  test('refuses an editor the routes that widen', async () => {
    const { handler } = routes({ ...ADMIN, role: 'editor' });
    const response = await handler.fetch(
      new Request('https://control.example.com/v1/profiles', {
        method: 'POST',
        headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'work' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/admin/);
  });

  test('lets an editor read', async () => {
    const { handler } = routes({ ...ADMIN, role: 'editor', scopes: [] });
    expect((await handler.fetch(get('/v1/connections'))).status).toBe(200);
  });

  test('answers an unknown path with 404 and reads nothing', async () => {
    const { handler, roots } = routes();
    expect((await handler.fetch(get('/v1/nope'))).status).toBe(404);
    expect(roots).toEqual([]);
  });
});

describe('reading a workspace', () => {
  test('hands the reader the root the assertion named', async () => {
    const { handler, roots } = routes();
    await handler.fetch(get('/v1/connections'));
    expect(roots).toEqual(['lanes://ws-aaa']);
  });

  test('serves a different workspace for a different assertion', async () => {
    const first = routes({ ...ADMIN, workspace: 'ws-aaa' });
    const second = routes({ ...ADMIN, workspace: 'ws-bbb' });

    await first.handler.fetch(get('/v1/connections'));
    await second.handler.fetch(get('/v1/connections'));

    expect(first.roots).toEqual(['lanes://ws-aaa']);
    expect(second.roots).toEqual(['lanes://ws-bbb']);
  });

  test('ignores a workspace the caller tried to name', async () => {
    // The whole point. A body or a query naming a workspace changes nothing,
    // because no route reads one.
    const { handler, roots } = routes();
    await handler.fetch(get('/v1/connections?workspace=ws-bbb'));
    expect(roots).toEqual(['lanes://ws-aaa']);
  });

  test('returns the connections with the workspace it acted in', async () => {
    const response = await routes().handler.fetch(get('/v1/connections'));
    const body = (await response.json()) as { workspace: string; connections: { key: string }[] };

    expect(body.workspace).toBe('ws-aaa');
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.key).toBe('gmail.con1');
  });

  test('returns the profiles', async () => {
    const response = await routes().handler.fetch(get('/v1/profiles'));
    const body = (await response.json()) as { profiles: unknown };

    expect(body.profiles).toEqual([{ name: 'personal', grants: 1, members: 1 }]);
  });
});

describe('what a read never returns', () => {
  test('no account content, only configuration', async () => {
    // The mirror of ADR-007: the endpoint holds the data and no control plane,
    // this holds the control plane and no data. A connection row names an
    // account; it does not carry a message, a note or a credential.
    const body = await (await routes().handler.fetch(get('/v1/connections'))).text();

    for (const forbidden of ['refresh_token', 'credential', 'password', 'body', 'subject:']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
