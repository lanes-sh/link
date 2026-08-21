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
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresIn: number;
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

/** Straight to the vendor, signed with a client this machine holds. */
export function directExchange(options: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
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
        client_secret: options.clientSecret,
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

    if (!response.ok || !body.access_token) {
      throw new OAuthError(
        `Token exchange failed: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim(),
      );
    }

    return settle(body, input.scopes);
  };
}

/** Through a broker, which holds the secret this machine does not have. */
export function brokerExchangeVia(options: {
  readonly url: string;
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

    return settle(tokens, input.scopes);
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
): OAuthTokens {
  if (!body.refresh_token) {
    // Without one, the connection works until the access token expires and then
    // quietly stops. Better to fail now with the actual cause. Google is named
    // because Google is who reaches this path: every provider that redeems a
    // code here is a Google REST one, and the others hand the exchange to the
    // MCP SDK. Naming the page beats describing it.
    throw new OAuthError(
      'Google returned no refresh token. This usually means the account was already authorised ' +
        'for this app; revoke it at https://myaccount.google.com/permissions and try again.',
    );
  }

  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token!,
    expiresIn: body.expires_in ?? 3600,
    scope: body.scope ?? scopes.join(' '),
    ...(body.id_token ? { idToken: body.id_token } : {}),
  };
}
