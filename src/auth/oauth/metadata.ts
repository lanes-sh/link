/**
 * The two documents a client reads before it tries to authenticate.
 *
 * Protected-resource metadata (RFC 9728) says *who* protects this resource;
 * authorization-server metadata (RFC 8414) says how to talk to that protector.
 * A client finds the first from the `WWW-Authenticate` header on a `401` and the
 * second from the `authorization_servers` entry in the first.
 *
 * Both are built from the request rather than from config, because the value
 * that has to be right is the one the user typed into their client — and this
 * endpoint does not know its own public URL. Cloud Run assigns a hostname with a
 * project hash in it, terminates TLS, and forwards the original host in a
 * header. A document built from config would name whatever the config guessed;
 * a document built from `request.url` alone would say `http`.
 */

export interface ResourceIdentity {
  /** The MCP endpoint URL as the client addresses it, e.g. `https://x.run.app/mcp`. */
  readonly resource: string;
  /** Where the authorization server lives — this origin, or an external issuer. */
  readonly issuer: string;
}

/**
 * Two scopes, and neither is a permission axis.
 *
 * What a caller may do is decided by the profile's policy, per capability, per
 * call, and recorded in the audit log. A second permission system expressed as
 * scopes could only either duplicate that or disagree with it, and a client
 * cannot be trusted to ask for less than it wants anyway. The scopes exist
 * because the protocol has a slot for them, and because a client reads that
 * slot to decide what this endpoint will do for it.
 */
export const MCP_SCOPE = 'mcp';

/**
 * OIDC Core §11's name for "issue me a refresh token", and the reason this
 * endpoint stopped sending its owner back to a browser.
 *
 * A refresh token has always been issued here, unconditionally. What was missing
 * was saying so. A client's requested scope defaults to whatever the *resource*
 * document lists, and the reference MCP client appends `offline_access` only
 * when the *authorization server* document advertises it:
 *
 * ```js
 * let effectiveScope = requestedScope || resourceMetadata?.scopes_supported?.join(" ") || …
 * if (effectiveScope && authServerMetadata?.scopes_supported?.includes("offline_access") && …)
 *   effectiveScope = `${effectiveScope} offline_access`;
 * ```
 *
 * So both documents matter and they matter differently. Advertising it in
 * neither left a client no grounds to request, persist, or use the refresh
 * token it was being handed — and a client with no grounds reconnects, which
 * means its owner approving in a browser.
 */
export const OFFLINE_ACCESS_SCOPE = 'offline_access';

/** Everything grantable here. A request for anything else is narrowed, not refused. */
export const SUPPORTED_SCOPES = [MCP_SCOPE, OFFLINE_ACCESS_SCOPE] as const;

/**
 * The grantable part of what was asked for.
 *
 * Empty means the request named nothing we recognise, and the caller falls back
 * to `MCP_SCOPE` — refusing with `invalid_scope` would turn an unknown token in
 * a client's default string into a connector that cannot be added at all, and
 * scope is not the thing protecting anything here.
 */
export function grantableScope(requested: string | null | undefined): string {
  const asked = new Set((requested ?? '').split(/\s+/).filter(Boolean));
  return SUPPORTED_SCOPES.filter((scope) => asked.has(scope)).join(' ');
}

export function protectedResourceMetadata(identity: ResourceIdentity): Record<string, unknown> {
  return {
    resource: identity.resource,
    authorization_servers: [identity.issuer],
    // Where a client's *default* requested scope comes from, so this is the
    // list that decides what an untouched connector asks for.
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    // And this is the list that gates whether `offline_access` is appended at
    // all. Both documents have to carry it; neither one alone is enough.
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Advertised because a spec-compliant client checks for it before starting
    // a flow, and refuses rather than silently downgrading to `plain`.
    code_challenge_methods_supported: ['S256'],
    // Clients registered here are public: they run on a phone or a laptop and
    // cannot keep a secret. Saying so is what lets them authenticate as `none`
    // at the token endpoint instead of inventing a credential to send.
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/**
 * Why a credential was refused, in RFC 6750 §3.1's vocabulary.
 *
 * There is one code worth sending and it carries the whole distinction a client
 * needs: `invalid_token` says the credential was *rejected*, where an otherwise
 * identical challenge says only that authorization is required. A client that
 * cannot tell those apart cannot tell "refresh — you hold a refresh token for
 * this" from "start a new authorization", and the safe-looking guess is the
 * second, which means the owner approving in a browser for a credential a
 * silent refresh would have replaced.
 *
 * Deliberately absent when nothing was presented. RFC 6750 §3: a resource
 * server SHOULD NOT include an error code where the request carried no
 * authentication information — and sending one would set a client refreshing a
 * credential it does not have.
 */
export interface ChallengeError {
  readonly code: 'invalid_token';
  readonly description: string;
}

/**
 * The `WWW-Authenticate` value on a 401.
 *
 * The `resource_metadata` pointer is the whole handshake: without it a client
 * has to guess the document's location by probing well-known paths, which costs
 * round trips and fails entirely on a host that does not serve them. Clients do
 * not honour this header on a `200`, so the status has to be right too.
 *
 * It stays on the header even when a token was rejected. A client that decides
 * to authorize after all — because the refresh was refused too — must not have
 * to go and find the document a second time.
 */
export function challenge(metadataUrl: string | null, error?: ChallengeError): string {
  // Every value is a quoted-string, so none may contain a quote. Both of these
  // are constants in this repository and the types keep them that way.
  const parts = [
    'realm="lanes-link"',
    ...(error ? [`error="${error.code}"`, `error_description="${error.description}"`] : []),
    ...(metadataUrl ? [`resource_metadata="${metadataUrl}"`] : []),
  ];

  return `Bearer ${parts.join(', ')}`;
}
