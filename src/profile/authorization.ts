import { z } from 'zod';
import { credentialRef } from './primitives.ts';

/**
 * How a remote MCP client gets a token, when a bearer string is not enough.
 *
 * A bearer token is what `claude mcp add --header` and every local registration
 * carry, and it stays the mechanism for those. It is not a mechanism a *remote*
 * client can use: Claude's and ChatGPT's connector flows expect the OAuth
 * handshake the MCP specification describes — a `401` naming a protected
 * resource, discovery, an authorization code with PKCE — and offer nowhere to
 * paste a fixed string.
 *
 * Two modes, because the choice is a real one and neither answer suits
 * everybody:
 *
 * - `self` — this endpoint issues the tokens. It registers clients dynamically,
 *   so adding a connector is pasting the URL and approving once. Nothing to set
 *   up, which is why it is the documented default: an identity provider you must
 *   first go and configure in a console is the most expensive step in the whole
 *   product, and it is paid by every user.
 * - `oidc` — an issuer you already run does it, and this endpoint only verifies.
 *   The cost is that the issuer must be reachable, must be registerable by the
 *   client (Google, for instance, supports neither dynamic registration nor
 *   client-ID metadata documents, so its client id has to be pasted in by hand),
 *   and must be told this endpoint's callback.
 *
 * Named for the protocol, not for a vendor — `issuer` is a URL, so pointing this
 * at Entra, Auth0, or an internal provider is an edit rather than a code path.
 * Absent means neither: bearer token only, exactly as before.
 */
const selfAuthorizationSchema = z.object({
  mode: z.literal('self'),
  /**
   * How long an issued access token lives.
   *
   * Short by design and refreshed rather than lengthened: a client that holds a
   * long-lived token has something worth stealing, and the refresh path is the
   * one that can be revoked by dropping a row.
   */
  access_token_ttl_minutes: z.number().int().positive().max(1440).default(60),
});

const oidcAuthorizationSchema = z.object({
  mode: z.literal('oidc'),
  /** Discovery root — `<issuer>/.well-known/openid-configuration` must resolve. */
  issuer: z.url(),
  /**
   * The audience a presented token must name.
   *
   * Not decoration. Without it, any token the same issuer minted for any other
   * application would open this endpoint — the confused-deputy case the MCP
   * authorization spec calls out by name.
   */
  client_id_ref: credentialRef,
  /**
   * Where to ask about a token, when the issuer's discovery document does not
   * say.
   *
   * Access tokens are often opaque, so checking one means asking the issuer.
   * RFC 7662 standardised that as `introspection_endpoint` in the metadata, and
   * several large issuers ship an equivalent without advertising one. A URL
   * here rather than a case in a switch — the same reasoning that puts the
   * S3-compatible service endpoint in config rather than naming a vendor.
   */
  introspection_endpoint: z.url().optional(),
  /**
   * Which subjects the issuer may vouch for. Matched against `sub` and against
   * a verified `email`.
   *
   * At least one, always. An empty list is the kind of default that reads as
   * "everyone" to whoever writes it and "no one" to whoever implemented it, and
   * default deny is not a thing to leave ambiguous.
   */
  allowed_subjects: z.array(z.string().min(1)).min(1),
});

export const authorizationSchema = z.discriminatedUnion('mode', [
  selfAuthorizationSchema,
  oidcAuthorizationSchema,
]);
