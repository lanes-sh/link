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
 * One scope, and it is not a permission axis.
 *
 * What a caller may do is decided by the profile's policy, per capability, per
 * call, and recorded in the audit log. A second permission system expressed as
 * scopes could only either duplicate that or disagree with it, and a client
 * cannot be trusted to ask for less than it wants anyway. The scope exists
 * because the protocol has a slot for one.
 */
export const MCP_SCOPE = 'mcp';

export function protectedResourceMetadata(identity: ResourceIdentity): Record<string, unknown> {
  return {
    resource: identity.resource,
    authorization_servers: [identity.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [MCP_SCOPE],
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
 * The `WWW-Authenticate` value on a 401.
 *
 * The `resource_metadata` pointer is the whole handshake: without it a client
 * has to guess the document's location by probing well-known paths, which costs
 * round trips and fails entirely on a host that does not serve them. Clients do
 * not honour this header on a `200`, so the status has to be right too.
 */
export function challenge(metadataUrl: string | null): string {
  return metadataUrl
    ? `Bearer realm="lanes-link", resource_metadata="${metadataUrl}"`
    : 'Bearer realm="lanes-link"';
}
