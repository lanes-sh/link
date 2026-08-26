import { z } from 'zod';
import { credentialRef, identifier } from './primitives.ts';
import { setupSchema } from './setup.ts';

/**
 * Credential types — how we prove who we are, orthogonal to how we connect.
 *
 * One folder per method under `../auth/`, and the union below is the complete
 * list of what a manifest may declare today. Adding one is a schema member
 * here, a folder there, and a branch in `../auth/resolve.ts` — see that
 * directory's README, which names the ones not built yet.
 */

export const authNoneSchema = z.object({ kind: z.literal('none') });

/**
 * A client somebody else operates, so the operator does not have to register one.
 *
 * An installed application cannot hold a confidential client: whatever ships in
 * the binary is readable by whoever runs it. That leaves exactly two honest
 * arrangements, and this declares the second — the operator registers their own,
 * or somebody runs one and performs the exchange on their behalf. The secret
 * lives behind these endpoints and never reaches this machine.
 *
 * Vendor-free by construction. The URL is data a provider supplies, so nothing
 * in this component learns whose client is behind it, or whose broker.
 */
export const authBrokerSchema = z.object({
  /** Base URL. `<url>/config`, `<url>/exchange`, `<url>/refresh`. */
  url: z.url(),
  /** Who runs it, named in the sentence shown before consent. */
  operator: z.string().min(1),
  docs_url: z.url().optional(),
});

export type AuthBroker = z.infer<typeof authBrokerSchema>;

/**
 * A second way in, for an authorization server that also accepts an assertion.
 *
 * RFC 7523: instead of a person approving a consent screen, the operator holds
 * a private key, signs a short-lived JWT with it, and exchanges that for an
 * access token. There is no refresh token because there is nothing to refresh —
 * a new assertion is signed whenever the last token ages out — which is the
 * whole reason this exists beside `oauth`. An authorization-code refresh token
 * can be expired by the issuer's own policy; a key the operator holds cannot.
 *
 * Declared *on* the OAuth block rather than as a fourth `kind`, because it is
 * an alternative arrangement for the same provider rather than a different
 * provider. Everything that branches on `kind` — where the credential lands,
 * what setup requires, which refs a deployed revision may rewrite — is
 * unchanged, and a manifest that omits this reads and behaves exactly as before.
 *
 * Which one a connection actually uses is not recorded here or in config. The
 * stored credential's *shape* is the switch, the same way an `oauth_apps` entry
 * is the switch between a broker's client and the operator's own.
 */
export const authAssertionSchema = z.object({
  /**
   * What the operator types after `--auth`, and how a chosen method is named
   * back to them.
   *
   * The provider's word rather than the protocol's. "Assertion" is what this is
   * to the authorization server and means nothing to the person holding the
   * file; they downloaded a service account key, and that is what the prompt
   * and the flag should say. Keeping it here is also what stops the CLI from
   * learning a vendor's vocabulary in order to print it.
   */
  method: identifier,
  /** The short name shown beside the choice — a noun, not a sentence. */
  label: z.string().min(1),
  /**
   * Whether the assertion may stand for itself, or must name a user to act as.
   *
   * `optional` — the key is an identity in its own right, and reaches whatever
   * has been shared with it. `required` — it can only borrow someone else's,
   * so a connection without a subject would authenticate cleanly and then find
   * nothing there. The CLI refuses a blank subject on `required` for that
   * reason: the failure is otherwise a 404 on every call with no explanation.
   */
  delegation: z.enum(['optional', 'required']).default('optional'),
  /**
   * Where the profile-shared key lives.
   *
   * Shared, not per-connection: one key covers every provider of a vendor, and
   * asking for it once per provider would be seven pastes of the same file.
   * The per-connection half is the subject, which is not a secret and is small
   * enough to sit in the pointer the connection stores.
   */
  key_ref: credentialRef,
  /** One line for the choice prompt: what this method reaches, and what it does not. */
  reach: z.string().min(1),
  /**
   * What to call the account this acts as, when it acts as one.
   *
   * Asked per connection and stored beside the pointer. Not a secret — it is an
   * address — but it lives in the credential store rather than in config
   * because it is half of a credential, and splitting a credential across two
   * files is how the halves come to disagree.
   */
  subject_label: z.string().min(1),
  /** The console walkthrough for this method, rendered by the same code as `setup`. */
  setup: setupSchema,
});

export type AuthAssertion = z.infer<typeof authAssertionSchema>;

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
  /**
   * Where to authorise when the profile declares no `oauth_apps` entry of its own.
   *
   * Additive rather than a third `registration` value, because the manifest is
   * not what chooses. `registration: manual` stays true either way — the vendor
   * does require a pre-registered client — and `app` still names the entry that
   * overrides this. What decides is the profile: declaring the entry means "my
   * own client", leaving it out means "the one the broker operates". A manifest
   * that claimed one or the other would be wrong half the time.
   */
  broker: authBrokerSchema.optional(),
  /**
   * The other way in, where the vendor offers one. Absent means browser or nothing.
   *
   * Additive and inert on its own: declaring it makes `connect` offer a choice
   * and makes the resolver able to read an assertion credential. It changes
   * nothing about a connection that authorised in a browser.
   */
  assertion: authAssertionSchema.optional(),
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
