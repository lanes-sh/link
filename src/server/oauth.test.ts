import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pkceChallengeFor } from '#auth';
import { allocatePort, startHarness, TEST_TOKEN, type Harness } from './harness.ts';

/**
 * The flow a remote connector actually drives.
 *
 * Over real HTTP against the real surface, because every failure this is meant
 * to catch lives in the wiring: a `401` without the pointer, a metadata document
 * naming a resource the client did not ask for, a code that can be replayed. A
 * unit test of the decision layer proves none of those.
 *
 * The client here is a few `fetch` calls rather than an SDK, deliberately —
 * what has to be right is the wire, and an SDK that papers over a missing header
 * would hide exactly the bug worth finding.
 */

const VERIFIER = 'a'.repeat(64);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let harness: Harness;
let origin: string;

/**
 * What the endpoint warned about.
 *
 * Captured rather than discarded because one of the refusals below has to be
 * *visible*: a replay that is refused silently is what made a connector losing
 * its authorization reconstructable only from object timestamps in a bucket.
 */
const warned: { message: string; detail?: Record<string, unknown> }[] = [];

/**
 * Real time plus an offset the tests move.
 *
 * The reuse interval is thirty seconds, and a test that waited it out would add
 * thirty seconds to the suite. An offset rather than a frozen clock so
 * everything else — code expiry, token expiry — behaves as it does in
 * production, and only the one thing under test is steered.
 */
let skewMs = 0;
const passTheReuseWindow = (): void => {
  skewMs += 31_000;
};

beforeAll(() => {
  harness = startHarness({
    profile: 'personal',
    port: allocatePort(),
    policy: `  allow:\n    - "example.*"`,
    authorization: true,
    now: () => Date.now() + skewMs,
    log: {
      debug() {},
      info() {},
      warn: (message, detail) => void warned.push({ message, ...(detail ? { detail } : {}) }),
      error() {},
    },
  });
  origin = new URL(harness.server.url).origin;
});

afterAll(() => harness.stop());

async function register(redirectUris: string[] = [REDIRECT]): Promise<string> {
  const response = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Test Client' }),
  });
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Walk authorize -> approve and return whatever came back on the redirect. */
async function authorise(
  clientId: string,
  overrides: Record<string, string> = {},
  token = TEST_TOKEN,
): Promise<Response> {
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallengeFor(VERIFIER),
    scope: 'mcp',
    state: 'opaque-state',
    token,
    ...overrides,
  });

  return fetch(`${origin}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
}

async function codeFrom(response: Response): Promise<string> {
  return new URL(response.headers.get('location')!).searchParams.get('code')!;
}

function tokenRequest(body: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

describe('discovery', () => {
  test('an unauthenticated call is refused with a pointer to the metadata', async () => {
    // The whole handshake hangs off this header. Without `resource_metadata` a
    // client has to guess the document's location, and one that guesses wrong
    // reports the endpoint as unreachable rather than as needing authorisation.
    const response = await fetch(`${origin}/mcp`, { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer realm="lanes-link", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
  });

  test('a rejected credential is told so, where an absent one is not', async () => {
    // RFC 6750 §3.1. Without `error="invalid_token"` this 401 is byte-identical
    // to the one above, and the difference it carries is the one that matters:
    // "the credential you sent was refused" is a refresh, "you have no
    // credential" is an authorization. The exact-match assertion above is the
    // other half of this test — §3 says a request carrying no authentication
    // information gets no error code, because a client cannot refresh a token
    // it does not hold.
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer lla_not-a-token-this-endpoint-ever-issued' },
    });

    expect(response.status).toBe(401);
    const header = response.headers.get('www-authenticate') ?? '';
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain('error_description=');
    // Still pointed at the document: a client that decides to authorize after
    // all must not have to go and find it a second time.
    expect(header).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
  });

  test('both documents say this endpoint will keep a client signed in', async () => {
    // The client's requested scope defaults to the *resource* document's list,
    // and the reference implementation appends `offline_access` only when the
    // *authorization server* document advertises it. Neither one alone is
    // enough, which is why both are asserted here rather than one standing in
    // for the other.
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
    const server = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();

    expect((resource as { scopes_supported: string[] }).scopes_supported).toEqual([
      'mcp',
      'offline_access',
    ]);
    expect((server as { scopes_supported: string[] }).scopes_supported).toEqual([
      'mcp',
      'offline_access',
    ]);
  });

  test('the resource document names the MCP endpoint and where to get a token', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`);

    expect(await response.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
  });

  test('the path-suffixed spelling answers too, because clients probe it first', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
  });

  test('the resource is built from the forwarded scheme, not the connection', async () => {
    // Cloud Run terminates TLS and forwards the original scheme in a header. A
    // document built from the incoming request would say `http`, which fails
    // the exact match the client makes against the URL its user typed.
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      headers: { 'x-forwarded-proto': 'https' },
    });

    const secure = origin.replace('http://', 'https://');
    expect(await response.json()).toMatchObject({
      resource: `${secure}/mcp`,
      authorization_servers: [secure],
    });
  });

  test('a forwarded host is ignored, so a caller cannot steer the documents', async () => {
    // `X-Forwarded-Host` used to be preferred over `Host`, and nothing needed it
    // — the argument for reading headers at all is about the *scheme*. What it
    // cost is that a caller decided what four documents said: both discovery
    // documents, the `resource_metadata` pointer on every `401`, and the form
    // action on the page that asks the owner for their endpoint token.
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example' },
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('attacker.example');
    expect(body['resource']).toBe(`${origin.replace('http://', 'https://')}/mcp`);
  });

  test('a forwarded scheme that is neither http nor https is not echoed into a URL', async () => {
    // Smaller than the host — naming a nonsense scheme downgrades nothing, it
    // just makes the client's exact match fail — but a header that decides part
    // of a URL should not accept an arbitrary string.
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      headers: { 'x-forwarded-proto': 'javascript' },
    });

    expect(await response.json()).toMatchObject({ resource: `${origin}/mcp` });
  });

  test('the authorization server advertises S256, which a client checks before starting', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
    expect(body['token_endpoint_auth_methods_supported']).toEqual(['none']);
    expect(body['registration_endpoint']).toBe(`${origin}/register`);
  });
});

describe('the authorization code flow', () => {
  test('register, approve, exchange, and the token opens the endpoint', async () => {
    const clientId = await register();

    const redirect = await authorise(clientId);
    expect(redirect.status).toBe(302);
    // State is round-tripped so the client can match the response to its request.
    expect(new URL(redirect.headers.get('location')!).searchParams.get('state')).toBe(
      'opaque-state',
    );

    const exchanged = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(redirect),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });

    expect(exchanged.status).toBe(200);
    const issued = (await exchanged.json()) as { access_token: string; refresh_token: string };
    expect(issued.access_token).toBeTruthy();

    const call = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expect(call.status).not.toBe(401);
  });

  test('the consent screen names the client and where the code would go', async () => {
    // Registration is open, so the name is self-reported and proves nothing.
    // The redirect host is the part an impostor cannot change, and the spec
    // requires showing it for exactly that reason.
    const clientId = await register();
    const page = await fetch(
      `${origin}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${pkceChallengeFor(VERIFIER)}&code_challenge_method=S256`,
    );

    const html = await page.text();
    expect(html).toContain('Test Client');
    expect(html).toContain('claude.ai');
    // And which target's store the token it asks for lives in. The endpoint
    // knows; the shell the reader runs the command in does not.
    expect(html).toContain('lanes link outputs --show --target local');
  });

  test('a client name cannot inject markup into the approval page', async () => {
    const response = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: '<script>alert(1)</script>',
      }),
    });
    const clientId = ((await response.json()) as { client_id: string }).client_id;

    const page = await fetch(
      `${origin}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${pkceChallengeFor(VERIFIER)}&code_challenge_method=S256`,
    );

    const html = await page.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the wrong endpoint token re-renders the form rather than redirecting', async () => {
    // The client has no business being told whether the owner typed their token
    // correctly, and a redirected error would end the flow on the first typo.
    const clientId = await register();
    const response = await authorise(clientId, {}, 'llk_not_the_token');

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('not accepted');
  });

  test('a code is single use', async () => {
    const clientId = await register();
    const code = await codeFrom(await authorise(clientId));
    const exchange = () =>
      tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      });

    expect((await exchange()).status).toBe(200);

    // A code that survives its exchange can be replayed by anyone who reached
    // the redirect — browser history, a proxy log, a referrer header.
    const replayed = await exchange();
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('a wrong PKCE verifier is refused', async () => {
    const clientId = await register();
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId)),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: 'b'.repeat(64),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('a code cannot be redeemed by a different client', async () => {
    const clientId = await register();
    const other = await register();

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId)),
      client_id: other,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });

    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('an unregistered redirect_uri never reaches a consent screen', async () => {
    // Errors here are shown, not redirected. Redirecting an error to a URI that
    // just failed validation is how an open redirector is built.
    const clientId = await register();
    const response = await fetch(
      `${origin}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=https://evil.example/steal&code_challenge=x&code_challenge_method=S256`,
      { redirect: 'manual' },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  test('PKCE is required, and plain is not a fallback', async () => {
    const clientId = await register();
    const response = await fetch(
      `${origin}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=x&code_challenge_method=plain`,
    );

    expect(response.status).toBe(400);
  });

  test('registration refuses a redirect that would carry a code in clear text', async () => {
    const response = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/callback'] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  test('a loopback redirect is matched without its port, for a native client', async () => {
    // RFC 8252: a native client binds an ephemeral port it cannot know at
    // registration time. Claude Code declares `http://localhost/callback` and
    // then listens on whatever it got.
    const clientId = await register(['http://localhost/callback']);
    const response = await authorise(clientId, {
      redirect_uri: 'http://localhost:51763/callback',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toStartWith('http://localhost:51763/callback?');
  });
});

describe('scope', () => {
  test('a request for offline access is granted and echoed back', async () => {
    // Echoed, because a client compares what it asked for against what it got:
    // granting less than was requested is how a connector decides it needs a
    // step-up authorization rather than a refresh.
    const clientId = await register();
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId, { scope: 'mcp offline_access' })),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { scope: string; refresh_token: string };
    expect(body.scope).toBe('mcp offline_access');
    expect(body.refresh_token).toBeTruthy();
  });

  test('a scope this endpoint does not grant is narrowed, not echoed', async () => {
    // It used to be recorded verbatim and handed straight back, which granted
    // by echo. Inert while `mcp` was the only scope; not inert now that there is
    // a second one that means something.
    const clientId = await register();
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId, { scope: 'mcp admin everything' })),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });

    expect((await response.json() as { scope: string }).scope).toBe('mcp');
  });

  test('a request naming nothing we know still gets a usable token', async () => {
    // Refusing with `invalid_scope` would turn an unrecognised token in some
    // client's default string into a connector that cannot be added at all, and
    // scope is not what protects anything here.
    const clientId = await register();
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId, { scope: 'wat' })),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });

    expect(response.status).toBe(200);
    expect((await response.json() as { scope: string }).scope).toBe('mcp');
  });
});

describe('refresh', () => {
  async function issue(): Promise<{ clientId: string; refresh: string }> {
    const clientId = await register();
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId)),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    const body = (await response.json()) as { refresh_token: string };
    return { clientId, refresh: body.refresh_token };
  }

  test('a refresh token buys a new access token and rotates itself', async () => {
    const { clientId, refresh } = await issue();
    const response = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).not.toBe(refresh);
  });

  test('a retry inside the reuse interval is answered, not refused', async () => {
    // The client refreshed, the response was lost, and the only move it has is
    // to send the same token again. Refusing that is `invalid_grant`, which the
    // reference client rethrows rather than recovers from — so the connector
    // dies and its owner is sent to a browser, over a network blip.
    const { clientId, refresh } = await issue();
    const first = (await (
      await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
      })
    ).json()) as { access_token: string };

    const retry = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });

    expect(retry.status).toBe(200);
    const answered = (await retry.json()) as { access_token: string; refresh_token: string };
    expect(answered.access_token).toBeTruthy();
    // A fresh pair rather than the one already issued: returning the same
    // strings would mean keeping them in plaintext for the window, and they are
    // stored hashed precisely so that is never necessary.
    expect(answered.access_token).not.toBe(first.access_token);

    const opened = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${answered.access_token}` },
    });
    expect(opened.status).not.toBe(401);
  });

  test('the rotated-away token stops working once the interval passes', async () => {
    // A captured refresh token is useful only until shortly after the real
    // client next refreshes, which is the whole point of rotating them.
    const { clientId, refresh } = await issue();
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    passTheReuseWindow();

    const replayed = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });

    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  test('a replayed refresh token does not kill the chain minted from it', async () => {
    // The reversal in ADR-035. A retry and a theft are still indistinguishable
    // from here, but the expensive answer was going to the wrong one far more
    // often: a family is minted once and never rotates, so revoking on replay
    // took out whichever pair happened to be in use at the time.
    const { clientId, refresh } = await issue();

    const rotated = (await (
      await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
      })
    ).json()) as { access_token: string; refresh_token: string };

    const opens = async (token: string): Promise<number> =>
      (
        await fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;

    expect(await opens(rotated.access_token)).not.toBe(401);

    passTheReuseWindow();
    const replayed = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' });

    // The whole point: somebody else's stale copy does not reach the pair in
    // use. It still opens the resource, and it still refreshes.
    expect(await opens(rotated.access_token)).not.toBe(401);

    const still = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: rotated.refresh_token,
      client_id: clientId,
    });
    expect(still.status).toBe(200);
  });

  test('a replay from any depth in the chain leaves the live pair working', async () => {
    // Two rotations deep, because nothing bounds how stale a copy can be: a
    // tombstone lives as long as the refresh token it replaced would have, so
    // the oldest token in a family has to be as harmless as the newest. The
    // incident this came from replayed one forty-four minutes after it was
    // spent, with a rotation in between.
    const { clientId, refresh: first } = await issue();

    const rotate = async (token: string): Promise<{ access_token: string; refresh_token: string }> =>
      (await (
        await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: token,
          client_id: clientId,
        })
      ).json()) as { access_token: string; refresh_token: string };

    const second = await rotate(first);
    const live = await rotate(second.refresh_token);
    passTheReuseWindow();

    for (const stale of [first, second.refresh_token]) {
      const replayed = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: stale,
        client_id: clientId,
      });
      expect(replayed.status).toBe(400);
    }

    const opened = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${live.access_token}` },
    });
    expect(opened.status).not.toBe(401);
  });

  test('a replay is recorded, because refusing it quietly explains nothing', async () => {
    // Refusing the token is half the answer; the other half is that the owner
    // can find out it happened. Nothing else in the endpoint's logs
    // distinguishes a replay from a client that simply never sent a credential.
    const { clientId, refresh } = await issue();
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    passTheReuseWindow();
    warned.length = 0;

    await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });

    const replay = warned.find((entry) => entry.message === 'refresh token replayed');
    expect(replay).toBeDefined();
    expect(replay?.detail).toMatchObject({ clientId });
  });

  test('a refresh token does not open the resource', async () => {
    // The two are indistinguishable as strings, so the kind check is the only
    // thing keeping a token meant for the token endpoint out of the MCP path.
    const { refresh } = await issue();
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${refresh}` },
    });

    expect(response.status).toBe(401);
  });
});

describe('open registration is bounded', () => {
  test('a live connector is never evicted to make room for a stranger', async () => {
    // Registration is open by design — it yields an identifier and nothing else
    // — but open means an unauthenticated caller can write rows, so the list is
    // capped. What must survive the cap is a client someone is actually using.
    const clientId = await register();
    const issued = await tokenRequest({
      grant_type: 'authorization_code',
      code: await codeFrom(await authorise(clientId)),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(issued.status).toBe(200);

    for (let index = 0; index < 210; index += 1) await register();

    // Still able to start a flow, which means its registration is still there.
    expect((await authorise(clientId)).status).toBe(302);
  });
});

describe('the static token still works', () => {
  test('a bearer token opens the endpoint with no flow at all', async () => {
    // The chain tries it first: it is a local constant-time compare and covers
    // the CLI, `outputs`, and every local registration.
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(response.status).not.toBe(401);
  });

  test('an unknown token is reported as invalid, not as missing', async () => {
    // The chain's last link never saw a credential of its kind, and reporting
    // that would describe a rejected token as an absent one.
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer llk_nope' },
    });

    expect(await response.json()).toMatchObject({ reason: 'invalid' });
  });
});
