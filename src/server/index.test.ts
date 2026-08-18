import { afterAll, describe, expect, test } from 'bun:test';
import { allocatePort, rpc, startHarness, TEST_TOKEN } from './harness.ts';
import { isLoopback } from './index.ts';

/**
 * End-to-end tests against a real HTTP server on a real port.
 *
 * Not a mocked transport: the claim worth proving is that an agent talking to
 * the actual endpoint sees only the tools its policy permits and is refused
 * everything else, and a mock cannot demonstrate that.
 */

/** personal: full access to connection a only. */
const personal = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"
  deny:
    - "example.list_notes"`,
});

/** work: deliberately narrower — read-only, and only on connection a. */
const work = startHarness({
  profile: 'work',
  port: allocatePort(),
  token: 'llk_work_token_value',
  policy: `  allow:
    - "example.get_note"
    - "example.list_notes"`,
});

afterAll(async () => {
  await Promise.all([personal.stop(), work.stop()]);
});

interface ToolDefinition {
  name: string;
  inputSchema: { properties?: { connection?: { enum?: string[] }; profile?: { enum?: string[] } } };
}

async function listTools(url: string, token?: string): Promise<ToolDefinition[]> {
  const response = await rpc(url, 'tools/list', {}, token ? { token } : {});
  return ((response.body['result'] as { tools?: ToolDefinition[] })?.tools ?? []).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
  options: { token?: string; clientLabel?: string; profile?: string } = {},
) {
  // `profile` is injected into every tool alongside `connection` now that one
  // endpoint serves the whole workspace. Defaulted here so each test says only
  // what it is actually about; the tests that are about profile pass it.
  const withProfile = { profile: options.profile ?? 'personal', ...args };
  const response = await rpc(url, 'tools/call', { name, arguments: withProfile }, options);
  const result = response.body['result'] as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;

  return {
    status: response.status,
    text: result?.content?.[0]?.text ?? '',
    isError: result?.isError === true,
    error: response.body['error'] as { message?: string } | undefined,
  };
}

describe('authentication', () => {
  test('serves a request carrying the profile token', async () => {
    expect((await rpc(personal.server.url, 'tools/list', {})).status).toBe(200);
  });

  test('refuses an unauthenticated request with a challenge', async () => {
    const response = await fetch(personal.server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  test('refuses a wrong token', async () => {
    expect((await rpc(personal.server.url, 'tools/list', {}, { token: 'llk_wrong' })).status).toBe(401);
  });

  test("a token from one profile does not open another profile's endpoint", async () => {
    // Profiles share no database, no credential store, and no URL. The token
    // boundary is the last of those three, and the one an agent touches.
    expect((await rpc(work.server.url, 'tools/list', {}, { token: TEST_TOKEN })).status).toBe(401);
    expect(
      (await rpc(personal.server.url, 'tools/list', {}, { token: 'llk_work_token_value' })).status,
    ).toBe(401);
  });

  test('health answers without a credential, but names nothing', async () => {
    // Liveness is unauthenticated on purpose: a platform health check reads it
    // and a deploy waits on it, and neither can hold a token. What used to come
    // with it was the name of every profile the endpoint serves — which on a
    // deployed URL is an inventory of what this instance holds, published to
    // anyone who asks.
    const url = new URL(personal.server.url);
    const response = await fetch(`${url.origin}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('a rebound Host is refused before anything else runs', async () => {
    // DNS rebinding is the one attack a loopback bind invites: an attacker's
    // short-TTL record resolves to 127.0.0.1 on the second lookup, the browser
    // calls the endpoint same-origin, and CORS stops applying. Host is what
    // survives that trip unchanged, so it is what gets checked.
    const url = new URL(personal.server.url);
    const response = await fetch(`${url.origin}/health`, {
      headers: { host: 'rebound.attacker.example' },
    });

    expect(response.status).toBe(403);
  });

  test('a cross-origin browser request is refused, even on a pre-auth route', async () => {
    // `/health`, the discovery documents and `/authorize` all answer before
    // authentication, by design — which makes them exactly what a rebound page
    // reaches. `/authorize` renders the form that asks for the owner's token.
    const url = new URL(personal.server.url);

    for (const path of ['/health', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(`${url.origin}${path}`, {
        headers: { origin: 'https://attacker.example' },
      });

      expect(response.status).toBe(403);
    }
  });

  test('a client that sends no Origin is unaffected', async () => {
    // Every non-browser MCP client — the CLI, Claude Desktop, a harness — sends
    // no Origin at all. Rejecting on absence would break all of them, so a
    // missing header passes and only a present, wrong one fails.
    const url = new URL(personal.server.url);
    const response = await fetch(`${url.origin}/health`);

    expect(response.status).toBe(200);
  });

  test('health names the profile to a caller holding the token', async () => {
    // The two callers this was published for — `outputs` and `mcp add` — both
    // hold the token already, and both use the name to tell this endpoint apart
    // from something else that answered on the same port.
    const url = new URL(personal.server.url);
    const response = await fetch(`${url.origin}/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(await response.json()).toEqual({
      status: 'ok',
      profile: 'personal',
      profiles: ['personal'],
    });
  });
});

describe('discovery is filtered by policy', () => {
  test('advertises only capabilities the profile can reach', async () => {
    const names = (await listTools(personal.server.url)).map((tool) => tool.name);

    // Wire names use underscores; the dotted form stays canonical in config,
    // policy, and audit.
    expect(names).toContain('example_echo');
    expect(names).toContain('example_set_note');
    expect(names).toContain('example_get_note');
  });

  test('a narrower profile sees a smaller tool list', async () => {
    const names = (await listTools(work.server.url, 'llk_work_token_value')).map((t) => t.name);

    expect(names.sort()).toEqual(['example_get_note', 'example_list_notes']);
    // The tool is not merely refused on call — it is not advertised at all.
    expect(names).not.toContain('example_set_note');
    expect(names).not.toContain('example_echo');
  });

  test('the connection enum exposes only granted connections', async () => {
    const tools = await listTools(personal.server.url);

    const echo = tools.find((tool) => tool.name === 'example_echo');
    const listNotes = tools.find((tool) => tool.name === 'example_list_notes');

    // A granted capability offers every account of its provider; a denied one
    // is not advertised at all, so a client cannot discover what it may not
    // call.
    expect(echo?.inputSchema.properties?.connection?.enum).toEqual(['example.a', 'example.b']);
    expect(listNotes).toBeUndefined();
  });

  test('server/discover reports the endpoint identity and supported revision', async () => {
    const response = await rpc(personal.server.url, 'server/discover', {});
    const result = response.body['result'] as {
      supportedVersions?: string[];
      _meta?: Record<string, { name?: string }>;
    };

    expect(result.supportedVersions).toContain('2026-07-28');
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('lanes-link');
  });

  test('server/discover leaks no capability names past the policy filter', async () => {
    // discover is a second discovery surface in this revision; if it enumerated
    // tools it would need the same filtering as tools/list.
    const response = await rpc(work.server.url, 'server/discover', {}, { token: 'llk_work_token_value' });
    expect(JSON.stringify(response.body)).not.toContain('set_note');
  });
});

describe('invocation', () => {
  test('routes to the named connection', async () => {
    const result = await callTool(personal.server.url, 'example_echo', {
      message: 'hello',
      connection: 'example.a',
    });

    expect(result.text).toBe('[example.a] hello');
    expect(result.isError).toBe(false);
  });

  test('state is isolated per connection', async () => {
    await callTool(personal.server.url, 'example_set_note', {
      key: 'shared-key',
      value: 'written via a',
      connection: 'example.a',
    });

    const fromA = await callTool(personal.server.url, 'example_get_note', {
      key: 'shared-key',
      connection: 'example.a',
    });
    const fromB = await callTool(personal.server.url, 'example_get_note', {
      key: 'shared-key',
      connection: 'example.b',
    });

    expect(fromA.text).toBe('written via a');
    expect(fromB.isError).toBe(true);
    expect(fromB.text).toContain('No note');
  });

  test('a connection outside the enum is refused', async () => {
    // Defence in depth: schema validation refuses it at the MCP layer, and
    // policy would refuse it again at dispatch if it got through.
    const result = await callTool(personal.server.url, 'example_echo', {
      message: 'sneaky',
      connection: 'example.nonexistent',
    });

    expect(result.isError || result.error !== undefined).toBe(true);
  });

  test('an unadvertised tool cannot be invoked by name', async () => {
    const result = await callTool(
      work.server.url,
      'example_set_note',
      { key: 'k', value: 'v', connection: 'example.a' },
      { token: 'llk_work_token_value', profile: 'work' },
    );

    expect(result.isError || result.error !== undefined).toBe(true);

    // And nothing was written: the read-only profile stayed read-only.
    const readBack = await callTool(
      work.server.url,
      'example_get_note',
      { key: 'k', connection: 'example.a' },
      { token: 'llk_work_token_value' },
    );
    expect(readBack.isError).toBe(true);
  });

  test('a provider error is a tool error, not a dead connection', async () => {
    const result = await callTool(personal.server.url, 'example_get_note', {
      key: 'definitely-not-there',
      connection: 'example.a',
    });

    expect(result.isError).toBe(true);
    // The endpoint is still serving afterwards.
    expect((await rpc(personal.server.url, 'tools/list', {})).status).toBe(200);
  });
});

describe('profiles are isolated', () => {
  test('state written through one profile is invisible from the other', async () => {
    await callTool(personal.server.url, 'example_set_note', {
      key: 'profile-scoped',
      value: 'personal only',
      connection: 'example.a',
    });

    const fromWork = await callTool(
      work.server.url,
      'example_get_note',
      { key: 'profile-scoped', connection: 'example.a' },
      { token: 'llk_work_token_value' },
    );

    expect(fromWork.isError).toBe(true);
  });

  test("each profile's audit log contains only its own events", async () => {
    const personalEvents = await personal.audit.tail({ limit: 100 });
    const workEvents = await work.audit.tail({ limit: 100 });

    expect(personalEvents.every((event) => event.profile === 'personal')).toBe(true);
    expect(workEvents.every((event) => event.profile === 'work')).toBe(true);
    expect(personalEvents.length).toBeGreaterThan(0);
  });
});

describe('audit over the wire', () => {
  test('records an allowed call with its connection and capability', async () => {
    const harness = startHarness({
      profile: 'audited',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"`,
    });

    try {
      await callTool(
        harness.server.url,
        'example_echo',
        { message: 'audit me', connection: 'example.a' },
        { profile: 'audited' },
      );

      const [event] = await harness.audit.tail();
      expect(event).toMatchObject({
        profile: 'audited',
        provider: 'example',
        connection: 'example.a',
        capability: 'example.echo',
        authorization: 'allowed',
        status: 'ok',
      });
    } finally {
      await harness.stop();
    }
  });

  test('records an attempt at a tool the profile was never shown', async () => {
    const harness = startHarness({
      profile: 'denials',
      port: allocatePort(),
      policy: `  allow:\n    - "example.get_note"`,
    });

    try {
      // set_note is not advertised on this profile, so the protocol layer
      // rejects it before dispatch. Without an explicit refusal record it
      // would leave no trace at all — and an agent probing for tools it does
      // not have is exactly what the log exists to capture.
      await callTool(
        harness.server.url,
        'example_set_note',
        { key: 'k', value: 'v', connection: 'example.a' },
        { profile: 'denials' },
      );

      const denied = await harness.audit.tail({ deniedOnly: true });
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        capability: 'example.set_note',
        authorization: 'denied_default',
        status: 'not_invoked',
        error: { kind: 'not_available' },
      });
    } finally {
      await harness.stop();
    }
  });

  test('an advertised call is not mistaken for a refusal', async () => {
    const harness = startHarness({
      profile: 'allowed',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"`,
    });

    try {
      await callTool(
        harness.server.url,
        'example_echo',
        { message: 'fine', connection: 'example.a' },
        { profile: 'allowed' },
      );

      expect(await harness.audit.tail({ deniedOnly: true })).toHaveLength(0);
      expect(await harness.audit.tail()).toHaveLength(1);
    } finally {
      await harness.stop();
    }
  });
});

describe('statelessness', () => {
  test('sequential calls need no session handshake', async () => {
    // No initialize, no session id, no ordering requirement — which is what
    // lets a serverless deployment replace the instance between requests.
    for (let i = 0; i < 3; i++) {
      const result = await callTool(personal.server.url, 'example_echo', {
        message: `call ${i}`,
        connection: 'example.a',
      });
      expect(result.text).toBe(`[example.a] call ${i}`);
    }
  });

  test('a restarted endpoint keeps serving the same agent', async () => {
    const port = allocatePort();
    const policy = `  allow:\n    - "example.*"`;

    const first = startHarness({ profile: 'restarted', port, policy });
    expect(
      (await callTool(
        first.server.url,
        'example_echo',
        { message: 'before', connection: 'example.a' },
        { profile: 'restarted' },
      )).text,
    ).toBe('[example.a] before');
    await first.stop();

    // A fresh process on the same port: an agent that held a "session" would
    // now be broken. Statelessness means it simply is not.
    const second = startHarness({ profile: 'restarted', port, policy });
    try {
      expect(
        (await callTool(
          second.server.url,
          'example_echo',
          { message: 'after', connection: 'example.a' },
          { profile: 'restarted' },
        )).text,
      ).toBe('[example.a] after');
    } finally {
      await second.stop();
    }
  });
});

describe('binding rules', () => {
  test('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });
});

describe('one endpoint, several profiles', () => {
  // The trade this design makes: one URL and one token reach every profile,
  // and the caller names which. Policy is still per profile, so what changes is
  // where the boundary is enforced — per call rather than per port.
  const both = startHarness({
    profile: 'personal',
    port: allocatePort(),
    policy: `  allow:\n    - "example.*"`,
    alsoServe: [{ profile: 'side', policy: `  allow:\n    - "example.get_note"` }],
  });

  afterAll(() => both.stop());

  test('health names every profile served, to a caller holding the token', async () => {
    const url = new URL(both.server.url);
    const response = await fetch(`${url.origin}/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(await response.json()).toEqual({
      status: 'ok',
      profile: 'personal',
      profiles: ['personal', 'side'],
    });
  });

  test('a tool offered by both profiles is registered once, with both in its enum', async () => {
    const tools = await listTools(both.server.url);
    const getNote = tools.find((tool) => tool.name === 'example_get_note');

    expect(getNote?.inputSchema.properties?.profile?.enum).toEqual(['personal', 'side']);
  });

  test('a tool only one profile grants offers only that profile', async () => {
    const tools = await listTools(both.server.url);
    const echo = tools.find((tool) => tool.name === 'example_echo');

    // `side` grants example.get_note alone, so echo is reachable in personal only.
    expect(echo?.inputSchema.properties?.profile?.enum).toEqual(['personal']);
  });

  test('the call is routed to the profile named', async () => {
    await callTool(
      both.server.url,
      'example_set_note',
      { key: 'k', value: 'written in personal', connection: 'example.a' },
      { profile: 'personal' },
    );

    const fromPersonal = await callTool(
      both.server.url,
      'example_get_note',
      { key: 'k', connection: 'example.a' },
      { profile: 'personal' },
    );
    const fromSide = await callTool(
      both.server.url,
      'example_get_note',
      { key: 'k', connection: 'example.a' },
      { profile: 'side' },
    );

    // Profiles share no database, so the note written in one is absent in the
    // other even though the connection key is spelled identically.
    expect(fromPersonal.text).toBe('written in personal');
    expect(fromSide.isError).toBe(true);
  });

  test('naming a profile that does not grant the capability is refused', async () => {
    // `side` has no grant for set_note, and the schema enum says so — but the
    // enum is a union across profiles for tools that several offer, so the
    // check has to exist at dispatch too.
    const result = await callTool(
      both.server.url,
      'example_set_note',
      { key: 'k', value: 'v', connection: 'example.a' },
      { profile: 'side' },
    );

    expect(result.isError || result.error !== undefined).toBe(true);
  });

  test('policy is still evaluated per profile', async () => {
    // Same token, same endpoint, different answer — which is the property that
    // has to survive collapsing the ports.
    const allowed = await callTool(
      both.server.url,
      'example_get_note',
      { key: 'anything', connection: 'example.a' },
      { profile: 'side' },
    );
    expect(allowed.error).toBeUndefined();
  });
});
