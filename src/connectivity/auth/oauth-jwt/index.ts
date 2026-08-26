import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import { credentialRefForConnection } from '../../manifest/credential-ref.ts';
import { parseAssertionKey, signAssertion } from './key.ts';

/**
 * OAuth 2.0 JWT bearer (RFC 7523) — a key the operator holds, in place of a
 * person approving a consent screen.
 *
 * The one property that earns this its own folder: there is no refresh token,
 * because there is nothing to refresh. A fresh assertion is signed whenever the
 * last access token ages out, so nothing an issuer can expire sits between the
 * operator and their data. An authorization-code refresh token is subject to
 * whatever policy the issuer applies to it — one such policy expires them after
 * seven days, and re-approving a browser screen every week is the failure this
 * folder exists to remove.
 *
 * What it costs is reach. An assertion authenticates the *key*, and a key is
 * not a person: it holds only what has been shared with it, unless the identity
 * provider has been configured to let it act as someone, which is an
 * administrator's grant rather than the operator's. `auth.assertion.delegation`
 * on the manifest is which of the two a provider is, and the CLI is where that
 * becomes a sentence.
 */

/** RFC 7523's grant type, and the marker that identifies a stored credential as one. */
export const ASSERTION_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * What a connection stores when it authenticates this way.
 *
 * A pointer and not the key itself. One key covers every provider of a vendor,
 * so it lives at a profile-shared ref and each connection records where to find
 * it plus the one thing that genuinely differs per connection — who it acts as.
 * Copying the key into seven connections would mean seven things to rotate.
 */
export interface StoredAssertion {
  readonly grant: typeof ASSERTION_GRANT;
  readonly key_ref: string;
  readonly subject?: string;
}

/**
 * Whether a stored credential is one of these.
 *
 * Both methods write to the same ref — `<provider>/<connection>` — and this is
 * what tells them apart. Shape rather than a flag in config, because
 * `credentialResolver` is handed a registry and a store and never a connection
 * row, so a declaration in config would be invisible exactly where the decision
 * has to be made.
 */
export function isStoredAssertion(value: unknown): value is StoredAssertion {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { grant?: unknown }).grant === ASSERTION_GRANT &&
    typeof (value as { key_ref?: unknown }).key_ref === 'string'
  );
}

/**
 * The stored credential for this connection, if it is an assertion pointer.
 *
 * `null` covers both "nothing stored" and "stored, but an authorization-code
 * blob" — the caller wants the same thing in either case, which is to carry on
 * down the path it was already on. Asked through `credentialRefForConnection`
 * rather than by assembling the ref here, because two files deriving that
 * separately is exactly the disagreement that function was extracted to end.
 */
export async function storedAssertionFor(
  manifest: ProviderManifest,
  connectionId: string,
  credentials: SecretStore,
): Promise<StoredAssertion | null> {
  const ref = credentialRefForConnection(manifest, connectionId);
  if (!ref) return null;

  const raw = await credentials.get(ref);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredAssertion(parsed) ? parsed : null;
  } catch {
    // A credential that is not JSON at all is a pasted token, which is somebody
    // else's case entirely. Not an error here.
    return null;
  }
}

/**
 * Minted tokens, for as long as this process lives.
 *
 * In memory rather than in the store, and that is a deliberate difference from
 * the authorization-code path. There, the refresh token is the credential and
 * persisting the rotation is the whole point. Here the credential is the key,
 * which nothing at request time modifies — so writing the token back would make
 * this ref rotatable, which a deployed revision would then need write access to
 * bind, to cache something that costs one signature and one POST to remake.
 */
const minted = new Map<string, { token: string; expiresAt: number }>();

/** Re-mint slightly early: a token that expires mid-flight fails the call it was fetched for. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Emptied when a reload lands, and by tests.
 *
 * The cache key is `<provider>.<connection>` with no subject in it, so a
 * connection re-connected to act as somebody else — or re-connected to a route
 * that is not this one at all — would otherwise keep serving the token minted
 * for who it used to be, for up to an hour after the config said otherwise.
 * `server/generations.ts` clears this beside `clearUpstreamTokens`, which
 * exists for the same reason on the other path.
 */
export function clearMintedTokens(): void {
  minted.clear();
}

interface TokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
}

/**
 * An access token for a connection that authenticates with a key.
 *
 * Reads the pointer, reads the key it names, signs, exchanges, caches. The
 * manifest supplies the scopes and nothing else — where to exchange comes from
 * the key file, so this stays a protocol implementation rather than a vendor's.
 */
export async function resolveAssertionToken(input: {
  readonly manifest: ProviderManifest;
  readonly connectionId: string;
  readonly stored: StoredAssertion;
  readonly credentials: SecretStore;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const { manifest, connectionId, stored, credentials } = input;
  const cacheKey = `${manifest.id}.${connectionId}`;

  const cached = minted.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) return cached.token;

  const raw = await credentials.get(stored.key_ref);
  if (!raw) {
    throw new Error(
      `No key stored at ${stored.key_ref}, which ${manifest.id}.${connectionId} authenticates with. ` +
        `Run: lanes link connect ${manifest.id} --replace`,
    );
  }

  const key = parseAssertionKey(raw, stored.key_ref);
  const scopes = manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [];

  const assertion = await signAssertion({
    key,
    scopes,
    ...(stored.subject ? { subject: stored.subject } : {}),
  });

  const response = await (input.fetch ?? globalThis.fetch)(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: ASSERTION_GRANT, assertion }),
  });

  const body = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || !body.access_token) {
    throw new Error(refusalMessage(manifest, stored, body, response.status));
  }

  minted.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });

  return body.access_token;
}

/**
 * Why the exchange was refused, in terms of what the operator can act on.
 *
 * Three of these are the whole population in practice and each has a different
 * fix in a different console, so the raw `invalid_grant` is worth translating.
 * An operator who reads only the error code goes looking in the wrong place —
 * most often at the key, when the actual gap is a grant an administrator has
 * not made yet.
 */
function refusalMessage(
  manifest: ProviderManifest,
  stored: StoredAssertion,
  body: TokenResponse,
  status: number,
): string {
  const detail = body.error_description ?? body.error ?? `HTTP ${status}`;
  const scopes = manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [];

  const lines = [`${manifest.name} refused the key at ${stored.key_ref}: ${detail}`];

  if (body.error === 'unauthorized_client') {
    lines.push(
      '',
      stored.subject
        ? `  The key is not permitted to act as ${stored.subject}. An administrator of that` +
            '\n  domain has to authorise this key for these scopes, all of them, exactly:'
        : '  The key is not authorised for these scopes:',
      ...scopes.map((scope) => `    ${scope}`),
      '',
      '  A partial list is refused the same way a missing one is.',
    );
  } else if (body.error === 'invalid_grant') {
    // Listed rather than diagnosed. This one code covers an account that does
    // not exist, a key that was deleted, a clock that is wrong, and a missing
    // subject — and the description above is the only thing that distinguishes
    // them. Asserting one of the four would send the reader to the wrong
    // console three times in four, which is worse than naming all of them.
    lines.push(
      '',
      '  The description above is the part that identifies which of these it is:',
      '  - the account in the key no longer exists, or the key was deleted or disabled;',
      "  - this machine's clock is wrong by more than a few minutes, and an assertion is",
      '    signed with a timestamp;',
      ...(stored.subject
        ? [`  - ${stored.subject} is not an account the key may act as.`]
        : [
            '  - this account has to be reached by acting as someone, and this connection acts',
            `    as nobody. Re-run and name one: lanes link connect ${manifest.id} --replace`,
          ]),
    );
  }

  return lines.join('\n');
}
