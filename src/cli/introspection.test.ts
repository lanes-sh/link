import { describe, expect, test } from 'bun:test';
import { introspectAccount } from './introspection.ts';

/**
 * The one identity answer that costs no per-vendor configuration.
 *
 * 75 of 105 manifests declare no `identity` block, almost all of them the
 * remote-MCP family that registers dynamically, and every one of them asked the
 * operator to type their own address a second after authorising. RFC 7662 is
 * what the authorization server already offers: the metadata says whether there
 * is an `introspection_endpoint`, and `username` is defined there as a
 * human-readable identifier for whoever authorized the token.
 *
 * The risk this carries is not returning nothing — that costs a question, which
 * is what happens today. It is returning `9f2c1e04-…`, which becomes the
 * account, the label, and the key a reconnect matches on, and reads exactly
 * like it worked. So every test below that rejects something is the point of
 * the file.
 */

const RESOURCE = 'https://mcp.example.com';
const INTROSPECT = 'https://mcp.example.com/introspect';
const USERINFO = 'https://mcp.example.com/userinfo';

/** A server that discovers to itself, the way every MCP server we have met does. */
function server(options: {
  introspection?: boolean;
  userinfo?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  status?: number;
}) {
  const posted: URLSearchParams[] = [];

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('oauth-protected-resource')) {
      // Notion's shape: the resource is its own authorization server, and the
      // SDK is left to fall back to it.
      return new Response('not found', { status: 404 });
    }

    if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
      return Response.json({
        issuer: RESOURCE,
        authorization_endpoint: `${RESOURCE}/authorize`,
        token_endpoint: `${RESOURCE}/token`,
        response_types_supported: ['code'],
        ...(options.introspection === false ? {} : { introspection_endpoint: INTROSPECT }),
        ...(options.userinfo ? { userinfo_endpoint: USERINFO } : {}),
      });
    }

    if (url === USERINFO) {
      return Response.json(options.userinfo ?? {});
    }

    if (url === INTROSPECT) {
      posted.push(new URLSearchParams(String(init?.body)));
      if (options.status && options.status >= 400) {
        return new Response('no', { status: options.status });
      }
      return Response.json({ active: true, ...options.claims });
    }

    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;

  return { fetchFn, posted };
}

const probe = (
  options: Parameters<typeof server>[0],
  client: { client_id?: string; client_secret?: string } = { client_id: 'cid' },
) => {
  const { fetchFn, posted } = server(options);
  return {
    posted,
    account: introspectAccount({
      resourceUrl: RESOURCE,
      accessToken: async () => 'tok',
      clientInformation: async () => client,
      fetch: fetchFn,
    }),
  };
};

describe('introspectAccount', () => {
  test('names the account from a human-readable username', async () => {
    expect(await probe({ claims: { username: 'ada' } }).account).toBe('ada');
  });

  test('reads an address, and prefers the username the RFC defines for it', async () => {
    expect(await probe({ claims: { email: 'ada@example.com' } }).account).toBe('ada@example.com');
    expect(
      await probe({ claims: { username: 'ada', email: 'other@example.com' } }).account,
    ).toBe('ada');
  });

  test('sends the token and the registered client, so a server that checks can', async () => {
    const attempt = probe({ claims: { username: 'ada' } }, {
      client_id: 'cid',
      client_secret: 'shh',
    });
    await attempt.account;

    const body = attempt.posted[0]!;
    expect(body.get('token')).toBe('tok');
    expect(body.get('token_type_hint')).toBe('access_token');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('shh');
  });

  /**
   * The failures that matter. Each of these would otherwise be written into
   * `connections.yaml` as the account and never questioned again.
   */
  test('refuses an opaque identifier rather than labelling a row with it', async () => {
    expect(await probe({ claims: { username: '9f2c1e04-3b7a-4c1d-9e55-1f2a3b4c5d6e' } }).account)
      .toBeNull();
    expect(await probe({ claims: { username: 'a1b2c3d4e5f60718293a4b5c' } }).account).toBeNull();
    expect(await probe({ claims: { username: '10029387' } }).account).toBeNull();
  });

  test('refuses the client id echoed back, which is us and not a person', async () => {
    expect(await probe({ claims: { username: 'cid' } }).account).toBeNull();
  });

  test('an inactive token is an answer about the token, not about a person', async () => {
    // Every other field is meaningless by the RFC once `active` is false, so
    // reading one would be reading a stale claim.
    expect(await probe({ claims: { active: false, username: 'ada' } }).account).toBeNull();
  });

  test('a server that advertises no introspection endpoint is not asked', async () => {
    const attempt = probe({ introspection: false });

    expect(await attempt.account).toBeNull();
    expect(attempt.posted).toHaveLength(0);
  });

  test('a refusal costs a round trip and nothing else', async () => {
    expect(await probe({ status: 401, claims: { username: 'ada' } }).account).toBeNull();
  });

  /**
   * The other half of "ask the authorization server".
   *
   * Measured across the 80 MCP endpoints this repository names, five advertise
   * introspection and three advertise userinfo — and they are not the same
   * three. Neither is common enough to replace a per-vendor identity block;
   * both are free once we are already talking to the server.
   */
  test('falls to OIDC userinfo where that is what the server offers', async () => {
    const attempt = probe({ introspection: false, userinfo: { email: 'ada@example.com' } });

    expect(await attempt.account).toBe('ada@example.com');
    expect(attempt.posted).toHaveLength(0);
  });

  test('and reaches for it when introspection is advertised but refuses', async () => {
    const attempt = probe({ status: 401, userinfo: { preferred_username: 'ada' } });

    expect(await attempt.account).toBe('ada');
    expect(attempt.posted).toHaveLength(1);
  });

  test('userinfo is held to the same rule — a subject id is not a name', async () => {
    expect(
      await probe({
        introspection: false,
        userinfo: { sub: '9f2c1e04-3b7a-4c1d-9e55-1f2a3b4c5d6e' },
      }).account,
    ).toBeNull();
  });

  test('no token means there is nothing to introspect', async () => {
    const { fetchFn, posted } = server({ claims: { username: 'ada' } });

    const account = await introspectAccount({
      resourceUrl: RESOURCE,
      accessToken: async () => null,
      clientInformation: async () => ({ client_id: 'cid' }),
      fetch: fetchFn,
    });

    expect(account).toBeNull();
    expect(posted).toHaveLength(0);
  });

  test('a discovery that throws falls through to the question, never upward', async () => {
    const account = await introspectAccount({
      resourceUrl: RESOURCE,
      accessToken: async () => 'tok',
      clientInformation: async () => ({ client_id: 'cid' }),
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });

    expect(account).toBeNull();
  });
});
