import { type ProviderManifest } from '#connectivity';
import type { ProviderRegistry } from '#registry';
import type { SecretStore } from '#secrets';
import { credentialResolver } from './resolve.ts';
import { resolveAssertionToken, storedAssertionFor } from './oauth-jwt/index.ts';
import { CredentialOAuthProvider } from './oauth-authcode/provider.ts';

/**
 * The bearer token for one connection, whichever way the provider came by it.
 *
 * An mcp connector sends `Authorization: Bearer <token>` and nothing else, so
 * it takes a token rather than a `Request` to authorise — the same shape
 * `basicCredential` has for IMAP and DAV, and for the same reason: a transport
 * that has no `Request` to hand an authorizer gets its credential as a bound
 * closure instead.
 *
 * What lives here that does not live in `./bearer/` is the *dispatch*. Two
 * unrelated arrangements produce a bearer token — an OAuth access token
 * exchanged on every use, and a long-lived one the operator pasted — and the
 * caller does not care which, only the manifest does. Putting that choice in
 * the bearer folder would make the folder that owns one method know about
 * another; putting it in `oauth-authcode/` would make the OAuth folder answer
 * for a token no OAuth flow ever produced.
 *
 * Before this existed, every caller asked `CredentialOAuthProvider` for the
 * token, and a manifest declaring `bearer` got `null` back rather than an
 * error: the provider's tokens ref is `<provider>/<connection>`, byte-identical
 * to the ref a pasted token derives, so it read the token, failed to parse it
 * as a JSON blob, and returned undefined by design. The connection then went
 * upstream with no `Authorization` header at all.
 */

/** One manifest, dressed as a registry, so the resolver needs no lookup. */
const only = (manifest: ProviderManifest): ProviderRegistry =>
  ({ manifest: () => manifest }) as unknown as ProviderRegistry;

/**
 * Throws where the manifest declares a credential and none is stored:
 * `credentialResolver` already says which ref is empty and which command fills
 * it, which beats a `null` that reaches the server as a missing header.
 */
export async function bearerToken(
  manifest: ProviderManifest,
  connectionId: string,
  secrets: SecretStore,
): Promise<string | null> {
  const resolved = await credentialResolver(only(manifest), secrets)(manifest.id, connectionId);

  switch (resolved.kind) {
    case 'none':
      return null;
    case 'oauth':
      return resolved.accessToken;
    case 'bearer':
      return resolved.token;
    default:
      // Unreachable: `defineProvider` refuses every other kind on an mcp
      // connector. Kept so the guard and this switch cannot drift apart
      // silently — if one is ever relaxed, the other says so.
      throw new Error(
        `Provider "${manifest.id}" resolves to a "${resolved.kind}" credential, which cannot be sent as a bearer token.`,
      );
  }
}

/**
 * The same token, read exactly as stored, without the refresh machinery.
 *
 * For `connect`: it has just written the token and wants that one, not a
 * refreshed one. Going through `bearerToken` there would populate the process's
 * access-token cache under the provisional connection id — `linear.pending`,
 * a key naming a connection that will not exist a moment later — and could
 * spend a network round trip re-exchanging a token written seconds ago.
 *
 * Identical to `bearerToken` for every non-OAuth kind, because a stored token
 * has no other reading.
 */
export async function bearerTokenAsStored(
  manifest: ProviderManifest,
  connectionId: string,
  secrets: SecretStore,
): Promise<string | null> {
  if (manifest.auth.kind !== 'oauth') return bearerToken(manifest, connectionId, secrets);

  // An assertion credential has no token stored to prefer — the token is minted
  // from the key, which is what "as stored" means here. Without this branch the
  // identity call `connect` makes immediately after writing the pointer reads
  // `access_token` off a blob that has none, sends no Authorization header, and
  // reports the credential rejected.
  const assertion = await storedAssertionFor(manifest, connectionId, secrets);
  if (assertion) {
    return resolveAssertionToken({ manifest, connectionId, stored: assertion, credentials: secrets });
  }

  const provider = new CredentialOAuthProvider({
    manifest,
    connectionId,
    credentials: secrets,
    scopes: manifest.auth.scopes,
  });

  const tokens = (await provider.tokens()) as { access_token?: string } | undefined;
  return tokens?.access_token ?? null;
}
