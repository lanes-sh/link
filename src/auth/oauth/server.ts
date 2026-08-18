import { MCP_SCOPE } from './metadata.ts';
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
 * consent scoping, no user directory. There is exactly one user here, and the
 * proof of being them is the endpoint token they already have.
 */

/** Codes live about as long as a redirect takes. */
const CODE_TTL_MS = 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type OAuthResult =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'redirect'; readonly location: string }
  /** Render the approval page. The parameters are carried through it. */
  | {
      readonly kind: 'consent';
      readonly request: AuthorizeRequest;
      readonly retry: boolean;
      /**
       * What the client calls itself, if it said.
       *
       * Self-reported and therefore not evidence — registration is open, so
       * anything may claim any name. It is shown because a name is what makes
       * the screen legible, and shown *beside the redirect host*, which is the
       * part that cannot be faked: an impostor calling itself Claude still has
       * to send the code somewhere, and that somewhere is on the screen.
       */
      readonly clientName?: string | undefined;
    }
  | { readonly kind: 'error'; readonly status: number; readonly message: string };

export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly scope: string;
  readonly resource: string | undefined;
}

export interface OAuthServerOptions {
  readonly store: OAuthStore;
  /** Proof of being the owner. The same token the endpoint already accepts. */
  readonly verifyOwner: (presented: string) => Promise<boolean>;
  readonly accessTokenTtlMs: number;
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
  async authorize(params: URLSearchParams): Promise<OAuthResult> {
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

    return {
      kind: 'consent',
      retry: false,
      ...(client.clientName ? { clientName: client.clientName } : {}),
      request: {
        clientId,
        redirectUri,
        codeChallenge: challenge,
        state: params.get('state') ?? undefined,
        scope: params.get('scope') || MCP_SCOPE,
        resource: params.get('resource') ?? undefined,
      },
    };
  }

  /**
   * The owner approving, by presenting the endpoint token.
   *
   * A wrong token re-renders the form rather than redirecting an error back to
   * the client: the client has no business being told whether the owner typed
   * their token correctly, and a redirect would end the flow on the first typo.
   */
  async approve(request: AuthorizeRequest, presented: string): Promise<OAuthResult> {
    const registered = await this.#options.store.client(request.clientId);

    if (!presented || !(await this.#options.verifyOwner(presented))) {
      return {
        kind: 'consent',
        request,
        retry: true,
        ...(registered?.clientName ? { clientName: registered.clientName } : {}),
      };
    }

    const client = registered;
    if (!client || !matchesRegistered(request.redirectUri, client.redirectUris)) {
      return { kind: 'error', status: 400, message: 'This approval no longer matches a client.' };
    }

    const code = randomToken('llx');
    const record: AuthorizationCode = {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      ...(request.resource ? { resource: request.resource } : {}),
      expiresAt: this.#now() + CODE_TTL_MS,
    };
    await this.#options.store.putCode(code, record);

    const location = new URL(request.redirectUri);
    location.searchParams.set('code', code);
    if (request.state !== undefined) location.searchParams.set('state', request.state);
    return { kind: 'redirect', location: location.toString() };
  }

  /** Both grants. Form-encoded in, JSON out, RFC 6749 error codes throughout. */
  async token(form: URLSearchParams): Promise<OAuthResult> {
    switch (form.get('grant_type')) {
      case 'authorization_code':
        return this.#exchangeCode(form);
      case 'refresh_token':
        return this.#refresh(form);
      default:
        return invalid('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
  }

  async #exchangeCode(form: URLSearchParams): Promise<OAuthResult> {
    const record = await this.#options.store.takeCode(form.get('code') ?? '');
    if (!record) return invalid('invalid_grant', 'That code is unknown, used, or expired.');

    if (record.clientId !== form.get('client_id')) {
      return invalid('invalid_grant', 'That code was issued to a different client.');
    }
    // Checked even though the code is already bound to it: a client that sends a
    // different redirect_uri here than it started with is not the client that
    // started, and the spec requires the comparison.
    if (record.redirectUri !== form.get('redirect_uri')) {
      return invalid('invalid_grant', 'redirect_uri does not match the authorization request.');
    }

    const verifier = form.get('code_verifier') ?? '';
    if (!verifier || pkceChallengeFor(verifier) !== record.codeChallenge) {
      return invalid('invalid_grant', 'code_verifier does not match the code_challenge.');
    }

    return this.#issue(record.clientId, record.scope, randomToken('llr'));
  }

  async #refresh(form: URLSearchParams): Promise<OAuthResult> {
    const presented = form.get('refresh_token') ?? '';
    const record = await this.#options.store.token(presented);

    if (!record || record.kind !== 'refresh') {
      return invalid('invalid_grant', 'That refresh token is unknown or expired.');
    }
    if (record.clientId !== form.get('client_id')) {
      return invalid('invalid_grant', 'That refresh token was issued to a different client.');
    }

    // Rotation: the presented token stops working the moment its replacement is
    // minted, so a captured refresh token is useful only until the real client
    // next refreshes — at which point one of the two presents a dead token and
    // the whole family is dropped.
    await this.#options.store.revokeToken(presented);
    return this.#issue(record.clientId, record.scope, randomToken('llr'), record.family);
  }

  async #issue(
    clientId: string,
    scope: string,
    refreshToken: string,
    family = randomToken('llf'),
  ): Promise<OAuthResult> {
    const accessToken = randomToken('lla');
    const expiresIn = Math.floor(this.#options.accessTokenTtlMs / 1000);

    await this.#options.store.putToken(accessToken, {
      clientId,
      kind: 'access',
      scope,
      family,
      expiresAt: this.#now() + this.#options.accessTokenTtlMs,
    });
    await this.#options.store.putToken(refreshToken, {
      clientId,
      kind: 'refresh',
      scope,
      family,
      expiresAt: this.#now() + REFRESH_TTL_MS,
    });

    return {
      kind: 'json',
      status: 200,
      body: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope,
      },
    };
  }
}

/** `base64url(sha256(verifier))`, which is what S256 means. */
export function pkceChallengeFor(verifier: string): string {
  return Buffer.from(
    new Bun.CryptoHasher('sha256').update(verifier, 'utf8').digest(),
  ).toString('base64url');
}

function invalid(error: string, description: string): OAuthResult {
  // RFC 6749 codes exactly. A client refreshing on a 401 branches on
  // `invalid_grant` specifically; anything else and it retries forever or gives
  // up without re-authorising.
  return { kind: 'json', status: 400, body: { error, error_description: description } };
}

/**
 * https, or loopback for a native client.
 *
 * A native client cannot receive an https redirect, so RFC 8252 has it listen
 * on a loopback port instead. Everything else is refused: a redirect to `http://`
 * on a routable host puts an authorization code on the wire in clear text.
 */
function isSafeRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
}

/**
 * Exact match, except for the port of a loopback URI.
 *
 * RFC 8252 §7.3 requires ignoring the port for the IP-literal form, because a
 * native client binds an ephemeral one it cannot know at registration time.
 * Claude Code declares `http://localhost/callback` and `http://127.0.0.1/callback`
 * and then listens on whatever port it got, so the same allowance has to cover
 * `localhost` or it never connects.
 */
export function matchesRegistered(candidate: string, registered: readonly string[]): boolean {
  if (registered.includes(candidate)) return true;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (!isLoopbackHost(parsed.hostname)) return false;

  return registered.some((uri) => {
    try {
      const other = new URL(uri);
      return (
        isLoopbackHost(other.hostname) &&
        other.protocol === parsed.protocol &&
        other.hostname === parsed.hostname &&
        other.pathname === parsed.pathname
      );
    } catch {
      return false;
    }
  });
}

export { hashToken };
