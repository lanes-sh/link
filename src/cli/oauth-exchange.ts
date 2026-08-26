import { BrokerError, brokerExchange } from '#connectivity/auth/index.ts';
import { OAuthError } from './oauth-error.ts';

/**
 * Turning an authorization code into tokens — the one step that needs a secret.
 *
 * Split from `oauth.ts` because it is the only part of the flow that differs
 * between a client the operator registered and a client somebody operates on
 * their behalf. Everything else — the loopback listener, PKCE, the state check,
 * the browser — is identical either way, and keeping it that way is the point:
 * a connection should not behave differently at runtime because of where its
 * client came from.
 */

export interface OAuthTokens {
  /** Absent where the vendor issues a long-lived token and never renews it. */
  readonly refreshToken?: string;
  readonly accessToken: string;
  /**
   * Absent where the vendor states no lifetime.
   *
   * Not defaulted to an hour: with no refresh token there is nothing to renew
   * with, so a made-up expiry would have `doctor` reporting a healthy
   * connection as stale forever and would tell the operator to re-run a command
   * that fixes nothing.
   */
  readonly expiresIn?: number;
  readonly scope: string;
  /**
   * An identity assertion, present when `openid` was granted.
   *
   * Opaque here on purpose. It is stored and handed back to whoever asked for
   * it, never decoded — the claim inside is unverified, and a tamperable local
   * store is not somewhere to read an identity from. What names an account is
   * the provider's own identity call, which asks and gets a checkable answer.
   */
  readonly idToken?: string;
}

export interface ExchangeInput {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  /** What was asked for, used only to fill in a response that omits `scope`. */
  readonly scopes: readonly string[];
}

export type ExchangeCode = (input: ExchangeInput) => Promise<OAuthTokens>;

/**
 * What a response without a refresh token means for this vendor.
 *
 * The two readings are opposite and neither is guessable from the response.
 * Google omitting one means the account was already authorised and the
 * connection will die in an hour — worth stopping for. Slack omitting one is
 * the ordinary success: a user token is long-lived unless token rotation is
 * switched on, so demanding one would refuse every connection that worked.
 */
export interface RefreshTokenPolicy {
  readonly required: boolean;
  /** Named in the refusal, so it is not always the vendor who first needed it. */
  readonly vendor: string;
  /** Where the operator withdraws the existing grant, when the manifest says. */
  readonly revokeUrl?: string | undefined;
}

/** Straight to the vendor, signed with a client this machine holds. */
export function directExchange(options: {
  readonly tokenUrl: string;
  readonly clientId: string;
  /**
   * Absent for a public client, where PKCE is the whole of the protection.
   *
   * A client id shipped in a public repository has no secret to go with it, and
   * inventing an empty one would be sent as `client_secret=` — which some
   * authorization servers read as a malformed confidential client rather than
   * as a public one, and refuse for a reason that names neither.
   */
  readonly clientSecret?: string | undefined;
  readonly refreshToken: RefreshTokenPolicy;
  readonly fetch?: typeof globalThis.fetch | undefined;
}): ExchangeCode {
  return async (input) => {
    const doFetch = options.fetch ?? globalThis.fetch;

    const response = await doFetch(options.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: options.clientId,
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
        code_verifier: input.codeVerifier,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    // Not every vendor signals failure with a status. Slack answers a refused
    // exchange with HTTP 200 and `{ok: false, error: ...}`, so the absent token
    // is what has to be trusted here rather than the code.
    if (!response.ok || !body.access_token) {
      throw new OAuthError(
        `Token exchange failed: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim(),
      );
    }

    return settle(body, input.scopes, options.refreshToken);
  };
}

/** Through a broker, which holds the secret this machine does not have. */
export function brokerExchangeVia(options: {
  readonly url: string;
  readonly refreshToken: RefreshTokenPolicy;
  readonly fetch?: typeof globalThis.fetch | undefined;
}): ExchangeCode {
  return async (input) => {
    let tokens;
    try {
      tokens = await brokerExchange(
        options.url,
        {
          code: input.code,
          codeVerifier: input.codeVerifier,
          redirectUri: input.redirectUri,
        },
        options.fetch ?? globalThis.fetch,
      );
    } catch (cause) {
      // Rethrown as-is when it is a BrokerError: it carries the notice and the
      // "your own client would fix this" flag that the caller renders, and
      // flattening it to a string here would throw both away.
      if (cause instanceof BrokerError) throw cause;
      throw new OAuthError(`Token exchange failed: ${String(cause)}`);
    }

    if (!tokens.access_token) {
      throw new OAuthError('The token exchange returned no access token.');
    }

    return settle(tokens, input.scopes, options.refreshToken);
  };
}

function settle(
  body: {
    access_token?: string | undefined;
    refresh_token?: string | undefined;
    id_token?: string | undefined;
    expires_in?: number | undefined;
    scope?: string | undefined;
  },
  scopes: readonly string[],
  refreshToken: RefreshTokenPolicy,
): OAuthTokens {
  if (!body.refresh_token && refreshToken.required) {
    // Without one, the connection works until the access token expires and then
    // quietly stops. Better to fail now with the actual cause. The vendor is
    // named rather than assumed: this used to say "Google" on the grounds that
    // Google was the only provider redeeming a code here, and it is not any
    // more.
    throw new OAuthError(
      `${refreshToken.vendor} returned no refresh token. This usually means the account was ` +
        'already authorised for this app; revoke it' +
        (refreshToken.revokeUrl ? ` at ${refreshToken.revokeUrl}` : '') +
        ' and try again.',
    );
  }

  return {
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    accessToken: body.access_token!,
    ...(body.expires_in !== undefined ? { expiresIn: body.expires_in } : {}),
    scope: body.scope ?? scopes.join(' '),
    ...(body.id_token ? { idToken: body.id_token } : {}),
  };
}
