import { z } from 'zod';
import { credentialRef, identifier } from './primitives.ts';

/**
 * Credential types — how we prove who we are, orthogonal to how we connect.
 *
 * One folder per method under `../auth/`, and the union below is the complete
 * list of what a manifest may declare today. Adding one is a schema member
 * here, a folder there, and a branch in `../auth/resolve.ts` — see that
 * directory's README, which names the ones not built yet.
 */

export const authNoneSchema = z.object({ kind: z.literal('none') });

export const authOAuthSchema = z.object({
  kind: z.literal('oauth'),
  /**
   * `dynamic` — the authorization server offers Dynamic Client Registration, so
   * we register ourselves and the operator does nothing at all (Notion, Linear).
   *
   * `manual` — the vendor requires a pre-registered client, so the operator
   * supplies an id and secret (Google, including for Google's own MCP servers).
   */
  registration: z.enum(['dynamic', 'manual']).default('dynamic'),
  /** Which `oauth_apps` entry holds the client, for `manual`. Shared across providers of a vendor. */
  app: identifier.optional(),
  scopes: z.array(z.string()).default([]),
  /**
   * Usually discovered from the resource's metadata; set only to override.
   *
   * Required for an `http` connector, which has no MCP metadata document to
   * discover from — a REST API is just a base URL, and where its authorization
   * server lives is not something the API itself announces.
   */
  authorize_url: z.url().optional(),
  token_url: z.url().optional(),
  /**
   * Extra parameters on the authorization request.
   *
   * Google needs `access_type=offline` and `prompt=consent`, without which it
   * returns an access token and no refresh token — the connection then works
   * for an hour and dies, which is a miserable thing to debug.
   */
  authorize_params: z.record(z.string(), z.string()).optional(),
});

export const authTokenSchema = z.object({
  kind: z.enum(['bearer', 'api_key', 'header', 'basic']),
  /** Header name for `header` / `api_key`. Defaults to `Authorization` / `X-API-Key`. */
  header: z.string().optional(),
  /** Send an `api_key` as a query parameter instead of a header. */
  query: z.string().optional(),
  /**
   * The vendor group this credential belongs to, when several providers share
   * one secret *per account*.
   *
   * Apple issues an app-specific password at account scope, so one password
   * genuinely unlocks iCloud Mail, Calendar, and Contacts together — three
   * providers, because they speak two protocols, but one thing to type. Setting
   * `app: icloud` on all three moves the derived ref from `<provider>/<account>`
   * to `icloud/<account>`.
   *
   * The same field on an *OAuth* block means something different and narrower:
   * which `oauth_apps` entry holds the client. It deliberately does not move
   * where tokens land, because Gmail and Drive share a Google client while
   * holding separate tokens granted under different scopes.
   */
  app: identifier.optional(),
  /**
   * Omit for a per-account credential, which is the usual case and derives.
   *
   * Declaring one means the opposite: a single secret shared by *every* account
   * of this provider — a service key, where the key is itself the identity.
   */
  credential_ref: credentialRef.optional(),
});

/**
 * A pluggable strategy, for auth no declarative form should try to express.
 *
 * This is the *only* place per-vendor code is permitted outside `local`
 * providers, and it exists because real APIs do things config cannot describe:
 * bunq generates an RSA keypair, runs a three-step handshake, signs every
 * request, and verifies the response signature. That earns ~150 lines of auth.
 * It must never come to mean per-endpoint code again.
 */
export const authStrategySchema = z.object({
  kind: z.literal('strategy'),
  strategy: identifier,
  credential_ref: credentialRef.optional(),
  /** Strategy-specific settings, validated by the strategy itself. */
  options: z.record(z.string(), z.unknown()).optional(),
});

export const authSchema = z.discriminatedUnion('kind', [
  authNoneSchema,
  authOAuthSchema,
  authTokenSchema,
  authStrategySchema,
]);

export type AuthConfig = z.infer<typeof authSchema>;
