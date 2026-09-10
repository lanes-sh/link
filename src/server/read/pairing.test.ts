import { describe, expect, test } from 'bun:test';
import { readRoutes, type AuditTail, type ReadDeps } from './routes.ts';
import { directPairingCredential } from './credential.ts';
import { pairingSessions } from './session.ts';
import type { ProfileRuntime } from '../mcp/visibility.ts';

/**
 * Turning the workspace's pairing token into a person.
 *
 * The step that did not exist. `lanes link pair` mints one credential per
 * workspace and it named nobody, so `/state`, `/audit` and `/data` answered
 * whoever held it with every profile the endpoint served. Now it opens the two
 * paths below and nothing else, and what it buys is a session carrying a
 * subject and the profiles that subject's `members:` name back (ADR-079).
 *
 * Driven over `readRoutes` rather than over `pairingRoutes` directly, because
 * the properties worth pinning are the ones the whole gate has: which
 * credential opens which path, and what a refusal is allowed to reveal.
 */

const ORIGIN = 'https://lanes.sh';
const PAIR_TOKEN = 'llp_the-workspace-token';
const SUBJECT = 'lanes:3QBmAxJLLrYSMTVUIeCN1SKFbdD3';

const AUDIT: AuditTail = { tail: async () => [] };

/** A profile runtime with only the `members:` the exchange reads. */
function profile(...subjects: string[]): ProfileRuntime {
  return {
    config: {
      description: null,
      grants: [],
      members: subjects.map((subject) => ({ subject, role: 'member' })),
    },
    registry: { capabilities: () => [] },
    policy: { byConnection: new Map() },
  } as unknown as ProfileRuntime;
}

const PROFILES = new Map([
  ['personal', profile(SUBJECT)],
  ['work', profile('lanes:SOMEBODY-ELSE')],
]);

/**
 * A federation that accepts one assertion, for one audience and nonce.
 *
 * The real `AssertionVerifier` is tested against real keys in
 * `auth/lanes/assertion.test.ts`. What matters here is that this surface passes
 * it the right audience and the right nonce, so the double refuses anything
 * else rather than checking the signature over again.
 */
function federation(accepts: { assertion: string; audience: string }) {
  return {
    consentUrl: 'https://lanes.sh/link/authorize',
    profilesFor: async () => [],
    verify: async (assertion: string, expected: { audience: string; nonce: string }) =>
      assertion === accepts.assertion && expected.audience === accepts.audience && expected.nonce
        ? { subject: SUBJECT, email: 'ada.lovelace@example.com' }
        : null,
  };
}

function deps(overrides: Partial<ReadDeps> = {}): ReadDeps {
  return {
    workspace: 'local',
    profiles: () => PROFILES,
    audit: AUDIT,
    connections: async () => [],
    credential: directPairingCredential({ read: async () => PAIR_TOKEN }),
    sessions: pairingSessions(store()),
    federation: federation({ assertion: 'a-signed-statement', audience: 'https://endpoint.test' }),
    endpoint: { kind: 'deployed', version: '0.0.0-test', certificateExpiresAt: null },
    ...overrides,
  };
}

function store() {
  const rows = new Map<string, string>();
  const at = (namespace: string, key: string) => `${namespace}/${key}`;
  return {
    get: async (namespace: string, key: string) => rows.get(at(namespace, key)) ?? null,
    set: async (namespace: string, key: string, value: string) =>
      void rows.set(at(namespace, key), value),
    delete: async (namespace: string, key: string) => void rows.delete(at(namespace, key)),
  };
}

function ask(
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { origin: ORIGIN };
  const token = init.token === undefined ? PAIR_TOKEN : init.token;
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return new Request(`https://endpoint.test${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** Walk the exchange the way the dashboard does, and return the session token. */
async function pair(read: ReadDeps): Promise<string> {
  const challenge = (await (await readRoutes(ask('/pair/challenge'), read)).json()) as {
    nonce: string;
  };

  const opened = await readRoutes(
    ask(`/pair/session?nonce=${challenge.nonce}`, {
      method: 'POST',
      body: { assertion: 'a-signed-statement' },
    }),
    read,
  );

  return ((await opened.json()) as { token: string }).token;
}

describe('what the pairing token opens', () => {
  test('the exchange, and not the surface behind it', async () => {
    const read = deps();

    expect((await readRoutes(ask('/pair/challenge'), read)).status).toBe(200);
    // The whole of the fix, in one assertion. This used to be a 200.
    expect((await readRoutes(ask('/state'), read)).status).toBe(401);
    expect((await readRoutes(ask('/audit'), read)).status).toBe(401);
    expect((await readRoutes(ask('/data/memory?profile=personal'), read)).status).toBe(401);
  });

  test('nothing at all, when it is the wrong token', async () => {
    const read = deps();

    const refused = await readRoutes(ask('/pair/challenge', { token: 'llp_not-it' }), read);

    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'unpaired', run: 'lanes link pair' });
  });
});

describe('the exchange', () => {
  test('hands back a session naming the person and the profiles that name them', async () => {
    const read = deps();
    const challenge = (await (await readRoutes(ask('/pair/challenge'), read)).json()) as {
      nonce: string;
      resource: string;
    };

    const opened = await readRoutes(
      ask(`/pair/session?nonce=${challenge.nonce}`, {
        method: 'POST',
        body: { assertion: 'a-signed-statement' },
      }),
      read,
    );
    const body = (await opened.json()) as { subject: string; profiles: string[]; token: string };

    expect(opened.status).toBe(200);
    expect(body.subject).toBe(SUBJECT);
    // `work` names somebody else, and this is the list that decides everything
    // downstream.
    expect(body.profiles).toEqual(['personal']);
    expect(body.token.startsWith('llps_')).toBe(true);
  });

  test('the audience is this surface, so a statement cannot be replayed at /mcp', async () => {
    const read = deps({
      federation: federation({ assertion: 'a-signed-statement', audience: 'https://elsewhere' }),
    });
    const challenge = (await (await readRoutes(ask('/pair/challenge'), read)).json()) as {
      nonce: string;
    };

    const opened = await readRoutes(
      ask(`/pair/session?nonce=${challenge.nonce}`, {
        method: 'POST',
        body: { assertion: 'a-signed-statement' },
      }),
      read,
    );

    expect(opened.status).toBe(401);
  });

  test('a nonce is spent once, so one statement cannot open two sessions', async () => {
    const read = deps();
    const challenge = (await (await readRoutes(ask('/pair/challenge'), read)).json()) as {
      nonce: string;
    };
    const replay = () =>
      readRoutes(
        ask(`/pair/session?nonce=${challenge.nonce}`, {
          method: 'POST',
          body: { assertion: 'a-signed-statement' },
        }),
        read,
      );

    expect((await replay()).status).toBe(200);

    expect((await replay()).status).toBe(400);
  });

  test('a statement that does not verify is refused with one reason', async () => {
    // Never "the audience was wrong". That tells an attacker which attempt got
    // closer and tells a legitimate caller nothing they can act on.
    const read = deps();
    const challenge = (await (await readRoutes(ask('/pair/challenge'), read)).json()) as {
      nonce: string;
    };

    const refused = await readRoutes(
      ask(`/pair/session?nonce=${challenge.nonce}`, {
        method: 'POST',
        body: { assertion: 'forged' },
      }),
      read,
    );

    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'assertion_invalid' });
  });

  test('an endpoint that cannot verify one says pairing is unavailable', async () => {
    // What a build older than this release looks like to a dashboard that has
    // learned to ask, so the page can name the version rather than showing an
    // opaque failure.
    const read = deps({ federation: undefined });

    const answer = await readRoutes(ask('/pair/challenge'), read);

    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ error: 'pairing_unavailable' });
  });
});

describe('what the session then opens', () => {
  test('the profiles that name its subject, and no others', async () => {
    const read = deps();
    const session = await pair(read);

    const state = await readRoutes(ask('/state', { token: session }), read);
    const body = (await state.json()) as { profiles: { name: string }[] };

    expect(state.status).toBe(200);
    expect(body.profiles.map((one) => one.name)).toEqual(['personal']);
  });

  test('a profile naming somebody else is not found, not forbidden', async () => {
    const read = deps();
    const session = await pair(read);

    const refused = await readRoutes(
      ask('/data/memory?profile=work', { token: session }),
      read,
    );

    expect(refused.status).toBe(404);
  });

  test('a session is not a pairing token, so it cannot open the exchange again', async () => {
    // The two credentials do one job each. A session that could mint another
    // session would make the workspace token's rotation meaningless.
    const read = deps();
    const session = await pair(read);

    expect((await readRoutes(ask('/pair/challenge', { token: session }), read)).status).toBe(401);
  });
});
