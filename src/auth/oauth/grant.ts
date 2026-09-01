import { grantableScope, MCP_SCOPE } from './metadata.ts';
import { invalid, type OAuthResult } from './result.ts';
import { randomToken, type OAuthStore } from './store.ts';

/**
 * Turning a code, or a refresh token, into an access token.
 *
 * Split from the browser leg because the two halves have nothing to say to each
 * other: this one never sees a person, a redirect or a consent screen, and the
 * other never mints a token. What passes between them is an `AuthorizationCode`
 * row, which is the whole interface.
 *
 * Free functions over a context rather than methods, so the split is a real one
 * — this file cannot reach the server's state except through what it is handed.
 */

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a spent refresh token still answers.
 *
 * A client whose refresh succeeded but whose *response* was lost holds a token
 * the server has already spent, and retrying with it is the only move it has.
 * Without a window that retry is `invalid_grant`, and the reference MCP client
 * rethrows every `OAuthError` but `server_error` rather than recovering — so
 * the connector dies and its owner is sent to a browser, over a network blip.
 *
 * Thirty seconds is the band Auth0's reuse interval (0–60 s) and Okta's grace
 * period occupy. What it costs: a captured refresh token keeps working for up
 * to this long after the real client next rotates it.
 */
const REFRESH_REUSE_MS = 30_000;

export interface GrantContext {
  readonly store: OAuthStore;
  readonly accessTokenTtlMs: number;
  /** Where a replayed refresh token is recorded. */
  readonly log?: { warn(message: string, detail?: Record<string, unknown>): void } | undefined;
  readonly now: () => number;
}

export async function exchangeCode(
  form: URLSearchParams,
  context: GrantContext,
): Promise<OAuthResult> {
  const record = await context.store.takeCode(form.get('code') ?? '');
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

  return issue(context, record.clientId, record.scope, randomToken('llr'), undefined, who(record));
}

export async function refresh(
  form: URLSearchParams,
  context: GrantContext,
): Promise<OAuthResult> {
  const presented = form.get('refresh_token') ?? '';
  const record = await context.store.token(presented);

  if (!record || record.kind === 'access') {
    return invalid('invalid_grant', 'That refresh token is unknown or expired.');
  }

  // A spent token presented again used to take its whole family with it, on
  // the reading that a replay is a theft. Against a real connector that was
  // wrong twice over, and ADR-035 has the evidence. Two answers replace it,
  // and the tombstone's age is what tells them apart.
  if (record.kind === 'consumed') {
    // The client first, before the window is even considered. A spent token
    // presented by a *different* client is not a retry however recent it is,
    // and accepting one meant a captured refresh token needed only a single
    // request inside the window to be turned into a fresh 30-day chain member
    // carrying the original holder's subject and profiles. The retry this
    // window exists for always comes from the client that spent it.
    if (record.clientId !== form.get('client_id')) {
      return invalid('invalid_grant', 'That refresh token was issued to a different client.');
    }

    // Inside the window it is a retry of a request already answered, and the
    // client is owed the answer rather than a dead connector. Not re-consumed:
    // a client retrying twice is still retrying.
    const spentAt = record.consumedAt;
    if (spentAt !== undefined && context.now() - spentAt <= REFRESH_REUSE_MS) {
      return issue(context, record.clientId, record.scope, randomToken('llr'), record.family, who(record));
    }

    // Outside it, refused on its own — and the family survives, which is the
    // half that was taking live sessions down with it.
    context.log?.warn('refresh token replayed', {
      clientId: record.clientId,
      family: record.family,
    });
    return invalid('invalid_grant', 'That refresh token has already been used.');
  }

  if (record.clientId !== form.get('client_id')) {
    return invalid('invalid_grant', 'That refresh token was issued to a different client.');
  }

  await context.store.consumeToken(presented);
  return issue(context, record.clientId, record.scope, randomToken('llr'), record.family, who(record));
}

/**
 * Mint an access token and the refresh that replaces it.
 *
 * `holder` rides along unchanged through every rotation. A refresh is the same
 * authorization continuing, so re-deciding who it belongs to would mean a
 * client silently changing identity between two requests — and re-reading
 * membership here would revoke a live session on a config edit, which is
 * exactly what ADR-060 says rotation is for instead.
 */
async function issue(
  context: GrantContext,
  clientId: string,
  scope: string,
  refreshToken: string,
  family = randomToken('llf'),
  holder: Holder = {},
): Promise<OAuthResult> {
  const accessToken = randomToken('lla');
  const expiresIn = Math.floor(context.accessTokenTtlMs / 1000);

  await context.store.putToken(accessToken, {
    clientId,
    kind: 'access',
    scope: grantableScope(scope) || MCP_SCOPE,
    family,
    ...holder,
    expiresAt: context.now() + context.accessTokenTtlMs,
  });
  await context.store.putToken(refreshToken, {
    clientId,
    kind: 'refresh',
    scope: grantableScope(scope) || MCP_SCOPE,
    family,
    ...holder,
    expiresAt: context.now() + REFRESH_TTL_MS,
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

type Holder = { subject?: string | undefined; profiles?: readonly string[] | undefined };

/** The identity half of a stored record, in the shape `issue` spreads. */
function who(record: Holder): Holder {
  return {
    ...(record.subject !== undefined ? { subject: record.subject } : {}),
    ...(record.profiles !== undefined ? { profiles: record.profiles } : {}),
  };
}

/** `base64url(sha256(verifier))`, which is what S256 means. */
export function pkceChallengeFor(verifier: string): string {
  return Buffer.from(
    new Bun.CryptoHasher('sha256').update(verifier, 'utf8').digest(),
  ).toString('base64url');
}
