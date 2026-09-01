import { exchangeCode, pkceChallengeFor, refresh, type GrantContext } from './grant.ts';
import { grantableScope, MCP_SCOPE } from './metadata.ts';
import { isSafeRedirect, matchesRegistered } from './redirects.ts';
import { invalid, type OAuthResult } from './result.ts';
import {
  hashToken,
  randomToken,
  type AuthorizationCode,
  type OAuthStore,
  type RegisteredClient,
} from './store.ts';

/**
 * The authorization-code flow, as decisions rather than as HTTP.
 *
 * Everything here takes parsed input and returns what should happen; the server
 * component turns that into a `Response`. That split is what makes the flow
 * testable as a sequence of values — a wrong PKCE verifier, a replayed code, a
 * redirect URI that does not match — instead of as a browser session.
 *
 * Deliberately small. This implements one grant and one refresh, for public
 * clients, with PKCE required. It is not a general authorization server and
 * should not grow into one: no client credentials grant, no implicit flow, no
 * consent scoping, no user directory.
 *
 * **It does not authenticate anybody, and that is the change in 0.8.0.** It used
 * to: `/authorize` rendered a form and the proof of being the owner was pasting
 * the endpoint's own bearer token into it. Two things were wrong with that. A
 * page on loopback asking for the one credential that opens everything is the
 * most valuable thing a hostile local page could reach (ADR-039), and a
 * credential is not a person — so a profile could not say *who* may consume it.
 *
 * Now the browser is sent to lanes.sh, which knows who is signed in, and comes
 * back with a signed assertion this endpoint verifies against a published key
 * (ADR-062). The endpoint learns a subject rather than a secret, and there is no
 * form on loopback to phish.
 */

/** Codes live about as long as a redirect takes. */
const CODE_TTL_MS = 60_000;

/** A person finding a password manager, not a redirect completing. */
const PENDING_TTL_MS = 10 * 60_000;

/**
 * Where this endpoint sends people to be identified, and how it checks the answer.
 *
 * Every field is injected rather than built here, which is what keeps this file
 * about the grant. It also means the whole federation can be replaced by a
 * self-hoster's own — `mode: oidc` is the supported way to do that, and this is
 * the same shape one layer down.
 */
export interface Federation {
  /** The page that knows who is signed in. `https://lanes.sh/link/authorize`. */
  readonly consentUrl: string;
  /**
   * Believe an assertion, or do not.
   *
   * Returns the person, or null. Deliberately no reason: whoever is at the
   * browser cannot act on "the audience was wrong", and an attacker can.
   */
  readonly verify: (
    assertion: string,
    expected: { audience: string; nonce: string },
  ) => Promise<{ subject: string; email: string | null } | null>;
  /**
   * The profiles that subject may consume here.
   *
   * Empty is a real answer and the common one for a stranger: they signed in
   * successfully, and no profile names them. It is refused with that reason,
   * because "sign in again" would be advice that cannot work.
   */
  readonly profilesFor: (subject: string) => Promise<readonly string[]>;
}

/** Who this endpoint is, from the point of view of the request being served. */
export interface EndpointIdentity {
  /** What an assertion must name as its audience — the MCP URL clients call. */
  readonly resource: string;
  /** Where lanes.sh sends the browser back to. */
  readonly callbackUrl: string;
}

export interface OAuthServerOptions {
  readonly store: OAuthStore;
  /** Where the person is identified. See `Federation`. */
  readonly federation: Federation;
  readonly accessTokenTtlMs: number;
  /** Where a replayed refresh token is recorded. Structural, because this layer
   * may not import `#connectivity`; the endpoint's own logger satisfies it. */
  readonly log?: { warn(message: string, detail?: Record<string, unknown>): void };
  readonly now?: () => number;
}

export class OAuthServer {
  readonly #options: OAuthServerOptions;
  readonly #now: () => number;

  constructor(options: OAuthServerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Dynamic client registration (RFC 7591).
   *
   * Open, and that is the design rather than an oversight: registering yields
   * only an identifier for a client that must still complete an approval this
   * endpoint's owner performs by hand. The alternative — a pre-registered client
   * id pasted into a console — is the setup step this whole mode exists to
   * remove.
   */
  async register(body: unknown): Promise<OAuthResult> {
    const input = body as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(input?.redirect_uris)
      ? input.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
      : [];

    if (uris.length === 0) {
      return invalid('invalid_redirect_uri', 'redirect_uris must list at least one URI');
    }
    for (const uri of uris) {
      if (!isSafeRedirect(uri)) {
        return invalid('invalid_redirect_uri', `"${uri}" is not an https or loopback URI`);
      }
    }

    const client: RegisteredClient = {
      clientId: randomToken('llc'),
      redirectUris: uris,
      ...(typeof input.client_name === 'string' ? { clientName: input.client_name } : {}),
      createdAt: this.#now(),
    };
    await this.#options.store.registerClient(client);

    return {
      kind: 'json',
      status: 201,
      body: {
        client_id: client.clientId,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(client.clientName ? { client_name: client.clientName } : {}),
      },
    };
  }

  /**
   * The authorization request, before anyone has approved anything.
   *
   * Errors here are shown rather than redirected. Redirecting an error to a URI
   * that failed validation is how an open redirector is built, so a bad
   * `client_id` or `redirect_uri` ends at this endpoint and goes no further.
   */
  async authorize(params: URLSearchParams, endpoint: EndpointIdentity): Promise<OAuthResult> {
    if (params.get('response_type') !== 'code') {
      return { kind: 'error', status: 400, message: 'Only response_type=code is supported.' };
    }
    if (params.get('code_challenge_method') !== 'S256') {
      return {
        kind: 'error',
        status: 400,
        message: 'PKCE is required, with code_challenge_method=S256.',
      };
    }

    const clientId = params.get('client_id') ?? '';
    const client = await this.#options.store.client(clientId);
    if (!client) {
      return { kind: 'error', status: 400, message: 'Unknown client. Register first.' };
    }

    const redirectUri = params.get('redirect_uri') ?? client.redirectUris[0] ?? '';
    if (!matchesRegistered(redirectUri, client.redirectUris)) {
      return { kind: 'error', status: 400, message: 'redirect_uri does not match a registered one.' };
    }

    const challenge = params.get('code_challenge') ?? '';
    if (!challenge) {
      return { kind: 'error', status: 400, message: 'code_challenge is required.' };
    }

    // Minted here and stored here. Everything the client asked for is kept
    // server-side under this nonce, so nothing coming back through the browser
    // is trusted — see `PendingAuthorization`.
    const nonce = randomToken('lln');

    await this.#options.store.putPending(nonce, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      ...(params.get('state') !== null ? { state: params.get('state')! } : {}),
      // The grantable part of what was asked for, not the request verbatim.
      // Echoing it back through `#issue` was granting by echo, which was inert
      // while `mcp` was the only scope and stops being inert now that there is
      // a second one that means something.
      scope: grantableScope(params.get('scope')) || MCP_SCOPE,
      ...(params.get('resource') !== null ? { resource: params.get('resource')! } : {}),
      expiresAt: this.#now() + PENDING_TTL_MS,
    });

    const consent = new URL(this.#options.federation.consentUrl);
    consent.searchParams.set('resource', endpoint.resource);
    consent.searchParams.set('nonce', nonce);
    consent.searchParams.set('return', endpoint.callbackUrl);
    // Both shown to the person, and the second is the one that cannot be
    // faked: a client may call itself anything, but the code still goes where
    // its registration says, and that host is on the screen beside the name.
    if (client.clientName) consent.searchParams.set('client', client.clientName);
    consent.searchParams.set('redirect_host', hostOf(redirectUri));

    return { kind: 'redirect', location: consent.toString() };
  }

  /**
   * The browser coming back from lanes.sh, carrying an assertion.
   *
   * This is where a person becomes a principal. Nothing in the query decides
   * anything except *which* pending request this is: the client, the redirect
   * URI and the PKCE challenge all come from the stored record, so a callback
   * fabricated wholesale can at most spend a nonce it does not have.
   *
   * Errors are rendered rather than redirected, for the reason `authorize`
   * gives: the redirect target is only trustworthy once the record it came
   * from has been read, and by then the interesting failures have happened.
   */
  async callback(params: URLSearchParams, endpoint: EndpointIdentity): Promise<OAuthResult> {
    const nonce = params.get('nonce') ?? '';
    const assertion = params.get('assertion') ?? '';

    if (!nonce || !assertion) {
      const refused = params.get('error');
      return {
        kind: 'error',
        status: 400,
        message: refused
          ? `Sign-in was not completed: ${refused}. Nothing was authorised.`
          : 'That sign-in came back without an assertion. Start again from your client.',
      };
    }

    const pending = await this.#options.store.takePending(nonce);
    if (!pending) {
      return {
        kind: 'error',
        status: 400,
        message: 'That sign-in has expired or was already used. Start again from your client.',
      };
    }

    const person = await this.#options.federation.verify(assertion, {
      audience: endpoint.resource,
      nonce,
    });
    if (!person) {
      return {
        kind: 'error',
        status: 403,
        message: 'That sign-in could not be verified, so nothing was authorised.',
      };
    }

    // Read once, at the moment the credential is minted. A profile that stops
    // naming this person later does not reach back and revoke a live session —
    // `lanes link token rotate` is what does that, and `profile members remove`
    // says so (ADR-060).
    const profiles = await this.#options.federation.profilesFor(person.subject);
    if (profiles.length === 0) {
      return {
        kind: 'error',
        status: 403,
        message:
          `You are signed in as ${person.email ?? person.subject}, and no profile on this ` +
          'endpoint lists you as a member.\n\n' +
          'Its owner can add you with:\n' +
          `  lanes link profile members add ${person.subject} --profile <name>`,
      };
    }

    // Re-checked against the registration, not taken on trust from the record.
    // The record was written by this endpoint, so this is belt and braces — but
    // a client deregistered mid-flow is a real sequence, and minting a code for
    // a redirect nobody claims any more is not something to do quietly.
    const client = await this.#options.store.client(pending.clientId);
    if (!client || !matchesRegistered(pending.redirectUri, client.redirectUris)) {
      return { kind: 'error', status: 400, message: 'This approval no longer matches a client.' };
    }

    const code = randomToken('llx');
    await this.#options.store.putCode(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scope: grantableScope(pending.scope) || MCP_SCOPE,
      ...(pending.resource ? { resource: pending.resource } : {}),
      subject: person.subject,
      profiles,
      expiresAt: this.#now() + CODE_TTL_MS,
    });

    const location = new URL(pending.redirectUri);
    location.searchParams.set('code', code);
    if (pending.state !== undefined) location.searchParams.set('state', pending.state);
    return { kind: 'redirect', location: location.toString() };
  }

  /** Both grants. Form-encoded in, JSON out, RFC 6749 error codes throughout. */
  async token(form: URLSearchParams): Promise<OAuthResult> {
    const context: GrantContext = {
      store: this.#options.store,
      accessTokenTtlMs: this.#options.accessTokenTtlMs,
      ...(this.#options.log ? { log: this.#options.log } : {}),
      now: this.#now,
    };

    switch (form.get('grant_type')) {
      case 'authorization_code':
        return exchangeCode(form, context);
      case 'refresh_token':
        return refresh(form, context);
      default:
        return invalid('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
  }
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export { hashToken, pkceChallengeFor };
export type { OAuthResult };
