import type { SecretStore } from '#secrets';
import type { ProviderManifest } from '#connectivity';

/**
 * The SDK's `OAuthClientProvider`, backed by our `SecretStore`.
 *
 * This one class is the whole reason a provider is now a manifest. The SDK
 * drives discovery, registration, authorization, and refresh; we only say where
 * the resulting material lives. **DCR and bring-your-own-client differ by a
 * single method**: whether `clientInformation()` returns something.
 *
 *   - returns a stored client  → the SDK uses it            (Google)
 *   - returns `undefined`      → the SDK registers via DCR  (Notion, Linear)
 *
 * Everything persists through the credential store, so registered clients and
 * refresh tokens are encrypted at rest like any other credential. That matters
 * for DCR in particular: re-registering orphans the previous grant, so the
 * client id has to survive restarts.
 */

/** Loosely typed against the SDK's shapes; the SDK validates them itself. */
type ClientInformation = Record<string, unknown> & { client_id?: string };
type Tokens = Record<string, unknown> & { refresh_token?: string; access_token?: string };

export interface OAuthProviderOptions {
  readonly manifest: ProviderManifest;
  readonly connectionId: string;
  readonly credentials: SecretStore;
  /** Loopback callback the CLI is listening on. Absent for non-interactive refresh. */
  readonly redirectUrl?: string | undefined;
  /** Opens the browser. Absent when refreshing, where no interaction is possible. */
  readonly openBrowser?: ((url: URL) => void) | undefined;
  readonly scopes?: readonly string[];
  /**
   * The `state` the CLI's loopback listener will accept. Absent for a
   * non-interactive refresh, which has no callback leg to bind.
   */
  readonly state?: string | undefined;
}

export class CredentialOAuthProvider {
  readonly #options: OAuthProviderOptions;
  #codeVerifier: string | undefined;
  #discoveryState: unknown;

  constructor(options: OAuthProviderOptions) {
    this.#options = options;
  }

  // --- where things live -------------------------------------------------

  /**
   * The registered client.
   *
   * For `manual` registration this is keyed by the shared `oauth_apps` entry,
   * because every Gmail and Drive connection authorises against the *same*
   * Google app. For `dynamic` it is keyed per provider, since the registration
   * belongs to us rather than to an operator-supplied app.
   */
  get #clientRef(): string {
    const auth = this.#options.manifest.auth;
    if (auth.kind === 'oauth' && auth.registration === 'manual' && auth.app) {
      return `${auth.app}/client`;
    }
    return `${this.#options.manifest.id}/client`;
  }

  get #tokensRef(): string {
    return `${this.#options.manifest.id}/${this.#options.connectionId}`;
  }

  // --- OAuthClientProvider ----------------------------------------------

  get redirectUrl(): string | undefined {
    return this.#options.redirectUrl;
  }

  get clientMetadata(): Record<string, unknown> {
    return {
      client_name: 'Lanes Link',
      client_uri: 'https://github.com/lanes-sh/link',
      redirect_uris: this.#options.redirectUrl ? [this.#options.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      ...(this.#options.scopes?.length ? { scope: this.#options.scopes.join(' ') } : {}),
    };
  }

  async clientInformation(): Promise<ClientInformation | undefined> {
    const auth = this.#options.manifest.auth;

    // Manual registration: the operator supplied a client, so hand it over and
    // the SDK will not attempt to register. Google requires this even for
    // Google's own MCP servers.
    if (auth.kind === 'oauth' && auth.registration === 'manual' && auth.app) {
      const [clientId, clientSecret] = await Promise.all([
        this.#options.credentials.get(`${auth.app}/client_id`),
        this.#options.credentials.get(`${auth.app}/client_secret`),
      ]);
      if (!clientId) return undefined;
      return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
    }

    // Dynamic: a previous registration, if we have one. Returning `undefined`
    // is what tells the SDK to register — and re-registering orphans the prior
    // grant, so this must survive restarts.
    return this.#read(this.#clientRef);
  }

  async saveClientInformation(information: ClientInformation): Promise<void> {
    await this.#write(this.#clientRef, information);
  }

  async tokens(): Promise<Tokens | undefined> {
    return this.#read(this.#tokensRef);
  }

  async saveTokens(tokens: Tokens): Promise<void> {
    // Stamp an absolute expiry alongside the relative `expires_in` the server
    // returns. Without it there is no way to tell a live access token from a
    // stale one after a restart, so every cold start would force a refresh —
    // and a refresh needs the network, which a serve path should not.
    const lifetime = typeof tokens['expires_in'] === 'number' ? (tokens['expires_in'] as number) : 3600;

    await this.#write(this.#tokensRef, {
      ...tokens,
      expires_at: Date.now() + lifetime * 1000,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.#options.openBrowser) {
      throw new Error(
        `Connection ${this.#options.manifest.id}.${this.#options.connectionId} needs re-authorisation, ` +
          `which requires a browser. Connect ${this.#options.manifest.id}.${this.#options.connectionId} again for this profile and target.`,
      );
    }
    this.#options.openBrowser(authorizationUrl);
  }

  /**
   * The CSRF binding between the authorization request and the callback.
   *
   * The SDK sends a `state` only if we return one here — `state?()` is optional
   * on its provider interface, and an absent method means the parameter is left
   * off the authorization URL entirely. The value belongs to the listener in
   * `captureOAuthCallback`, which is what compares it on the way back; this
   * method only carries it outbound.
   *
   * Undefined during refresh, which has no callback leg. The SDK omits the
   * parameter, which is correct: there is nothing to bind.
   */
  state(): string | undefined {
    return this.#options.state;
  }

  /**
   * SEP-2352: bind the callback leg to the authorization server discovered on
   * the first leg.
   *
   * Held in memory beside the code verifier, and for the same reason — both are
   * valid for exactly one exchange. Without it the SDK cannot check that the
   * callback came back from the server it started with, which is an
   * authorization-server mix-up defence worth having rather than a warning
   * worth silencing.
   */
  saveDiscoveryState(state: unknown): void {
    this.#discoveryState = state;
  }

  discoveryState(): unknown {
    return this.#discoveryState;
  }

  saveCodeVerifier(codeVerifier: string): void {
    // In memory only: it is valid for one exchange and is worthless afterwards,
    // so persisting it would add a stored secret for no benefit.
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.#codeVerifier) throw new Error('No PKCE code verifier for this flow');
    return this.#codeVerifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.#codeVerifier = undefined;
      return;
    }
    if (scope === 'discovery') {
      this.#discoveryState = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      await this.#options.credentials.delete(this.#tokensRef).catch(() => {});
    }
    if (scope === 'client' || scope === 'all') {
      // Only ever a dynamically registered client. An operator-supplied one is
      // theirs, and deleting it would silently break every other connection
      // sharing that oauth_apps entry.
      const auth = this.#options.manifest.auth;
      const manual = auth.kind === 'oauth' && auth.registration === 'manual';
      if (!manual) await this.#options.credentials.delete(this.#clientRef).catch(() => {});
    }
  }

  // --- storage helpers ---------------------------------------------------

  async #read<T>(ref: string): Promise<T | undefined> {
    const raw = await this.#options.credentials.get(ref);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Unparseable stored credential: treat as absent so the flow can recover
      // by re-registering rather than failing permanently.
      return undefined;
    }
  }

  async #write(ref: string, value: unknown): Promise<void> {
    await this.#options.credentials.set(ref, JSON.stringify(value));
  }
}

/**
 * Access tokens for upstream calls, cached in memory and never persisted.
 *
 * Short-lived by design, so storing one would add a credential to protect for
 * no benefit. Keyed per connection, so two accounts never share a token, and a
 * cold instance simply refreshes.
 */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export function clearUpstreamTokens(): void {
  accessTokens.clear();
}

const EXPIRY_MARGIN_MS = 60_000;

export async function upstreamAccessToken(options: {
  connectionKey: string;
  provider: CredentialOAuthProvider;
  refresh: (provider: CredentialOAuthProvider) => Promise<Tokens | undefined>;
  now?: () => number;
}): Promise<string | null> {
  const now = (options.now ?? Date.now)();
  const cached = accessTokens.get(options.connectionKey);
  if (cached && cached.expiresAt > now + EXPIRY_MARGIN_MS) return cached.token;

  const stored = await options.provider.tokens();
  const expiresAt = typeof stored?.['expires_at'] === 'number' ? (stored['expires_at'] as number) : 0;

  if (stored?.access_token && expiresAt > now + EXPIRY_MARGIN_MS) {
    accessTokens.set(options.connectionKey, { token: stored.access_token, expiresAt });
    return stored.access_token;
  }

  // Only refresh when there is something to refresh with. Not every
  // authorization server issues a refresh token — Notion's does not — and
  // calling the SDK's `auth()` without one fails in a way that looks like a
  // configuration bug rather than "this token simply cannot be renewed".
  // Hand back what we have and let a 401 surface as "re-authorise", which is
  // the truthful instruction.
  if (!stored?.refresh_token) return stored?.access_token ?? null;

  const refreshed = await options.refresh(options.provider);
  if (!refreshed?.access_token) return stored?.access_token ?? null;

  const lifetime = typeof refreshed['expires_in'] === 'number' ? (refreshed['expires_in'] as number) : 3600;
  accessTokens.set(options.connectionKey, {
    token: refreshed.access_token,
    expiresAt: now + lifetime * 1000,
  });

  return refreshed.access_token;
}
