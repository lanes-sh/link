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

  test('claims the parameterised mutation paths too', () => {
    // The gap that would make every mutation unreachable in production while
    // each one passed its own test: the router asks this predicate first, and a
    // path it does not claim never reaches `controlRoutes` at all.
    expect(isControlPath('/v1/profiles/personal')).toBe(true);
    expect(isControlPath('/v1/profiles/personal/grants/gmail.con1')).toBe(true);
    expect(isControlPath('/v1/profiles/personal/policy/deny/gmail.send')).toBe(true);
    expect(isControlPath('/v1/profiles/personal/members/lanes:xyz')).toBe(true);
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

describe('creating a profile', () => {
  const post = (body: unknown) =>
    new Request('https://runtime.internal/v1/profiles', {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const withCreate = (over: Partial<ControlDeps> = {}) =>
    deps({
      create: async (name: string) => ({
        name,
        path: `/w/profiles/${name}/profile.yaml`,
        port: 7337,
        targets: ['managed'],
        copiedFrom: {},
      }),
      ...over,
    });

  test('an admin holding the scope creates one', async () => {
    const response = await controlRoutes(post({ name: 'work' }), withCreate());
    expect(response.status).toBe(201);
    expect((await response.json() as { profile: string }).profile).toBe('work');
  });

  test('an editor may not, because creating one widens what an agent reaches', async () => {
    const response = await controlRoutes(
      post({ name: 'work' }),
      withCreate({ verifier: { async verify() { return { ...ADMIN, role: 'editor' as const }; } } }),
    );
    expect(response.status).toBe(403);
  });

  test('an admin without the scope may not, and is told which box to tick', async () => {
    const response = await controlRoutes(
      post({ name: 'work' }),
      withCreate({ verifier: { async verify() { return { ...ADMIN, scopes: [] }; } } }),
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toMatch(/link:admin/);
  });

  test('refuses a name the config format would not accept', async () => {
    // Rejected here rather than by the writer, so a malformed name is a 400
    // naming the rule instead of whatever a YAML path error looks like.
    for (const name of ['', 'Has Spaces', '../escape', 'UPPER']) {
      const response = await controlRoutes(post({ name }), withCreate());
      expect(response.status, name).toBe(400);
    }
  });

  test('refuses a body that is not what it says it is', async () => {
    const bad = new Request('https://runtime.internal/v1/profiles', {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: 'not json',
    });
    expect((await controlRoutes(bad, withCreate())).status).toBe(400);
  });

  test('creates it in the workspace the assertion named, and nowhere else', async () => {
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    await controlRoutes(
      post({ name: 'work' }),
      withCreate({
        create: async (name: string, options) => {
          seen.push(options.env);
          return { name, path: '/w/x', port: 7337, targets: ['managed'], copiedFrom: {} };
        },
      }),
    );

    expect(seen[0]?.['LANES_LINK_HOME']).toBe('lanes://ws-aaa');
  });

  test('reports a name already taken as a conflict rather than a failure', async () => {
    const response = await controlRoutes(
      post({ name: 'work' }),
      withCreate({
        create: async () => {
          throw new Error('Profile "work" already exists at /w/profiles/work/profile.yaml');
        },
      }),
    );
    expect(response.status).toBe(409);
  });
});

describe('granting a connection to a profile', () => {
  const put = (profile: string, connection: string) =>
    new Request(`https://runtime.internal/v1/profiles/${profile}/grants/${connection}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer a.b.c' },
    });

  const withGrant = (over: Partial<ControlDeps> = {}, closed = false) =>
    deps({
      grant: async (connection: string) => ({
        profile: 'personal',
        target: 'managed',
        connection,
        account: 'someone@example.com',
        allowed: [`${connection.split('.')[0]}.*`],
        published: '',
      }),
      // Whether the *target profile* is open to being changed by an agent.
      agentMayManage: async () => !closed,
      ...over,
    });

  test('an admin holding the scope grants one', async () => {
    const response = await controlRoutes(put('personal', 'gmail.con1'), withGrant());
    expect(response.status).toBe(200);
    expect((await response.json() as { connection: string }).connection).toBe('gmail.con1');
  });

  test('an editor may not: a grant is what widens reach', async () => {
    const response = await controlRoutes(
      put('personal', 'gmail.con1'),
      withGrant({ verifier: { async verify() { return { ...ADMIN, role: 'editor' as const }; } } }),
    );
    expect(response.status).toBe(403);
  });

  test('a profile closed to agents refuses, whatever the caller may do elsewhere', async () => {
    // The third gate, and the only one belonging to the thing being changed.
    // The caller here is an admin holding every scope.
    const response = await controlRoutes(put('personal', 'gmail.con1'), withGrant({}, true));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toMatch(/agent/i);
  });

  test('the switch is read before anything is written', async () => {
    const wrote: string[] = [];
    await controlRoutes(
      put('personal', 'gmail.con1'),
      withGrant(
        {
          grant: async (connection: string) => {
            wrote.push(connection);
            return { profile: 'personal', target: 'managed', connection, account: '', allowed: [], published: '' };
          },
        },
        true,
      ),
    );

    expect(wrote).toEqual([]);
  });

  test('refuses a connection reference the format would not accept', async () => {
    // Shapes that reach the route and fail its check.
    for (const bad of ['nodot', 'UPPER.x', 'gmail.']) {
      expect((await controlRoutes(put('personal', bad), withGrant())).status, bad).toBe(400);
    }
  });

  test('a traversal never reaches a route at all', async () => {
    // `new URL` normalises `..` out before the matcher runs, so the path loses
    // segments and matches nothing. Asserted rather than assumed: it is the
    // reason the matcher needs no traversal check of its own, and if URL
    // parsing ever stopped doing it this is what would say so.
    const response = await controlRoutes(put('personal', '../../escape'), withGrant());
    expect(response.status).toBe(404);
  });

  test('reports a connection the workspace does not hold as the caller fault it is', async () => {
    const response = await controlRoutes(
      put('personal', 'gmail.nope'),
      withGrant({
        grant: async () => {
          throw new Error('This workspace holds no connection "gmail.nope".');
        },
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe('the rest of the mutations', () => {
  const call = (method: string, path: string, body?: unknown) =>
    new Request(`https://runtime.internal${path}`, {
      method,
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  // A policy rule governs one connection (ADR-058), so the route requires one.
  const POLICY = '/v1/profiles/personal/policy/deny/gmail.send_message';
  const ON = { connection: 'gmail.con1' };

  const withWriters = (over: Partial<ControlDeps> = {}) =>
    deps({
      agentMayManage: async () => true,
      revoke: async () => true,
      policy: async () => ({ profile: 'personal', capability: 'gmail.send_message', effect: 'deny' as const }),
      addMember: async () => ({ profile: 'personal', subject: 'lanes:xyz', role: 'member' }),
      removeMember: async () => true,
      removeProfileNamed: async () => ({ profile: 'personal', survived: 0 }),
      ...over,
    });

  test('revoking a grant', async () => {
    const response = await controlRoutes(
      call('DELETE', '/v1/profiles/personal/grants/gmail.con1'),
      withWriters(),
    );
    expect(response.status).toBe(200);
  });

  test('narrowing a capability with a deny rule', async () => {
    const response = await controlRoutes(call('PUT', POLICY, ON), withWriters());
    expect(response.status).toBe(200);
  });

  test('a rule naming no connection is refused, because it governs one', async () => {
    // With two mailboxes granted there is no answer to "which one" that is not
    // a guess about which account the caller meant to narrow.
    const response = await controlRoutes(call('PUT', POLICY, {}), withWriters());
    expect(response.status).toBe(400);
  });

  test('an effect that is neither allow nor deny is not a route', async () => {
    // `approval_required` is reserved in the policy model and fails closed
    // there; it is not offered here at all rather than accepted and ignored.
    const response = await controlRoutes(
      call('PUT', '/v1/profiles/personal/policy/maybe/gmail.send_message', ON),
      withWriters(),
    );
    expect(response.status).toBe(404);
  });

  test('adding a member', async () => {
    const response = await controlRoutes(
      call('PUT', '/v1/profiles/personal/members/lanes:xyz'),
      withWriters(),
    );
    expect(response.status).toBe(200);
  });

  test('a subject that is not a lanes subject is refused', async () => {
    // A profile's members: names `lanes:<uid>` and nothing else. A bare uid
    // would look like a working delegation and reach nothing.
    for (const bad of ['xyz', 'google:xyz', 'lanes:']) {
      const response = await controlRoutes(
        call('PUT', `/v1/profiles/personal/members/${encodeURIComponent(bad)}`),
        withWriters(),
      );
      expect(response.status, bad).toBe(400);
    }
  });

  test('removing a member', async () => {
    const response = await controlRoutes(
      call('DELETE', '/v1/profiles/personal/members/lanes:xyz'),
      withWriters(),
    );
    expect(response.status).toBe(200);
  });

  test('removing a profile', async () => {
    const response = await controlRoutes(call('DELETE', '/v1/profiles/personal'), withWriters());
    expect(response.status).toBe(200);
  });

  test('a removal that left something behind says so rather than reporting success', async () => {
    // `survived` non-zero means a credential is still live. Reporting 200 would
    // tell somebody their account was cleaned up when it was not.
    const response = await controlRoutes(
      call('DELETE', '/v1/profiles/personal'),
      withWriters({ removeProfileNamed: async () => ({ profile: 'personal', survived: 2 }) }),
    );
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toMatch(/still/i);
  });

  test('every one of them needs admin, the scope, and an open profile', async () => {
    const paths: [string, string, unknown?][] = [
      ['DELETE', '/v1/profiles/personal/grants/gmail.con1'],
      ['PUT', POLICY, ON],
      ['PUT', '/v1/profiles/personal/members/lanes:xyz'],
      ['DELETE', '/v1/profiles/personal/members/lanes:xyz'],
      ['DELETE', '/v1/profiles/personal'],
    ];

    for (const [method, path, body] of paths) {
      const editor = await controlRoutes(
        call(method, path, body),
        withWriters({ verifier: { async verify() { return { ...ADMIN, role: 'editor' as const }; } } }),
      );
      expect(editor.status, `${method} ${path} as editor`).toBe(403);

      const unscoped = await controlRoutes(
        call(method, path, body),
        withWriters({ verifier: { async verify() { return { ...ADMIN, scopes: [] }; } } }),
      );
      expect(unscoped.status, `${method} ${path} without the scope`).toBe(403);

      const closed = await controlRoutes(
        call(method, path, body),
        withWriters({ agentMayManage: async () => false }),
      );
      expect(closed.status, `${method} ${path} on a closed profile`).toBe(403);
    }
  });
});
