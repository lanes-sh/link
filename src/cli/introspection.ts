import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/client';

/**
 * Asking the authorization server who it just issued a token to.
 *
 * The declared `identity` block (`identity.ts`) is per-vendor and most vendors
 * have none — 75 of 105 manifests, almost all of them the remote-MCP family
 * that registers dynamically. Every one of those made a person type their own
 * address into `connect` a second after authorising, which is the one thing an
 * OAuth round trip ought to have settled.
 *
 * RFC 7662 is the standard answer and costs no per-vendor configuration: the
 * authorization server metadata we already fetch says whether there is an
 * `introspection_endpoint`, and the response's `username` is defined as "a
 * human-readable identifier for the resource owner who authorized this token".
 *
 * **This asks the server rather than reading the token.** That distinction is
 * the whole reason this is allowed to exist where decoding the stored
 * `id_token` is not (`oauth-exchange.ts`): a claim in a local file is
 * unverified and the store is tamperable, while an introspection response is
 * the issuer answering for itself.
 *
 * Best-effort throughout. A server with no introspection endpoint, one that
 * refuses a public client, or one that answers with an opaque id costs a round
 * trip and falls through to the prompt.
 */

export interface IntrospectionProbe {
  /** The protected resource — the MCP endpoint this connection talks to. */
  readonly resourceUrl: string;
  readonly accessToken: () => Promise<string | null>;
  /** The registered client, for servers that want the caller authenticated. */
  readonly clientInformation: () => Promise<
    { client_id?: string | undefined; client_secret?: string | undefined } | undefined
  >;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Whether a returned identifier is one a person would recognise.
 *
 * The failure this guards against is not a probe that returns nothing — that
 * one falls through to the prompt and costs a question. It is a probe that
 * returns `9f2c1e04-…` or the client id, which becomes the account, the label,
 * and the key a reconnect matches on, and reads exactly like it worked.
 *
 * An address is accepted outright. Anything else has to at least look like a
 * name: letters, and not the shapes an opaque identifier takes.
 */
function readable(value: unknown, clientId: string | undefined): string | null {
  if (typeof value !== 'string') return null;

  const candidate = value.trim();
  if (candidate.length === 0 || candidate === clientId) return null;
  if (candidate.includes('@')) return candidate;

  // A uuid, a long hex or base64-ish blob, or anything with no letters in it.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) return null;
  if (/^[0-9a-zA-Z_-]{16,}$/.test(candidate) && !/[ .]/.test(candidate)) return null;
  if (!/[a-z]/i.test(candidate)) return null;

  return candidate;
}

/** The two endpoints an authorization server may offer for this, per RFC 8414. */
async function askableEndpoints(
  resourceUrl: string,
  fetchFn: typeof globalThis.fetch,
): Promise<{ introspection: string | null; userinfo: string | null }> {
  // The resource names its authorization servers; where it names none, the
  // resource is its own, which is the shape every MCP server we have met takes.
  let authorizationServer = resourceUrl;
  try {
    const resource = await discoverOAuthProtectedResourceMetadata(resourceUrl, undefined, fetchFn);
    const declared = (resource as { authorization_servers?: string[] }).authorization_servers;
    if (declared?.[0]) authorizationServer = declared[0];
  } catch {
    // Fall through to the resource itself.
  }

  const metadata = (await discoverAuthorizationServerMetadata(authorizationServer, {
    fetchFn,
  })) as { introspection_endpoint?: string; userinfo_endpoint?: string } | undefined;

  const named = (value: unknown) =>
    typeof value === 'string' && value.length > 0 ? value : null;

  return {
    introspection: named(metadata?.introspection_endpoint),
    userinfo: named(metadata?.userinfo_endpoint),
  };
}

/**
 * OIDC's answer to the same question, for the servers that offer that instead.
 *
 * Measured across the 80 MCP endpoints this repository names: five advertise
 * introspection and three advertise userinfo, and they are different servers.
 * Neither is common enough to make the per-vendor `identity` blocks
 * unnecessary; both are free to ask once we are already here.
 */
async function fromUserinfo(
  endpoint: string,
  token: string,
  send: typeof globalThis.fetch,
): Promise<string | null> {
  const response = await send(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) return null;

  const claims = (await response.json()) as Record<string, unknown>;
  return (
    readable(claims['email'], undefined) ??
    readable(claims['preferred_username'], undefined) ??
    readable(claims['name'], undefined)
  );
}

export async function introspectAccount(probe: IntrospectionProbe): Promise<string | null> {
  const send = probe.fetch ?? globalThis.fetch;

  try {
    const token = await probe.accessToken();
    if (!token) return null;

    const endpoints = await askableEndpoints(probe.resourceUrl, send);
    if (!endpoints.introspection) {
      return endpoints.userinfo ? await fromUserinfo(endpoints.userinfo, token, send) : null;
    }

    const client = await probe.clientInformation();

    // `client_secret_post` where we hold a secret, and the bare `client_id`
    // where we do not — the two methods a dynamically registered public client
    // is offered. A server wanting neither ignores both fields.
    const body = new URLSearchParams({ token, token_type_hint: 'access_token' });
    if (client?.client_id) body.set('client_id', client.client_id);
    if (client?.client_secret) body.set('client_secret', client.client_secret);

    const response = await send(endpoints.introspection, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!response.ok) {
      return endpoints.userinfo ? await fromUserinfo(endpoints.userinfo, token, send) : null;
    }

    const claims = (await response.json()) as Record<string, unknown>;

    // `active: false` is a valid, successful answer meaning the token is not
    // one this server will speak for. Every other field is then meaningless by
    // the RFC, so reading one would be reading a stale claim.
    if (claims['active'] === false) return null;

    return (
      readable(claims['username'], client?.client_id) ??
      readable(claims['email'], client?.client_id)
    );
  } catch {
    return null;
  }
}
