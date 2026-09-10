import { distrustUpstreamToken } from './oauth-authcode/provider.ts';
import { distrustMintedToken } from './oauth-jwt/index.ts';

/**
 * Stop trusting a connection's access token, wherever it is being remembered.
 *
 * A connection is keyed `<provider>.<connection>` in both token caches, and
 * which one holds it is a property of how the credential was obtained rather
 * than of anything the caller did: an authorization-code grant caches under
 * `oauth-authcode`, a service-account key under `oauth-jwt`. Both are reached
 * through the same manifest `auth.kind: 'oauth'`, because an assertion is an
 * optional second way in to the same block — so the layer that sees a 401
 * cannot tell them apart, and should not have to.
 *
 * Its own file rather than a line in the barrel, because it is the one place
 * that has to know both halves exist. Missing the second half is what left a
 * service-account connection resending a refused token for an hour while the
 * connection beside it recovered.
 */
export function distrustConnectionToken(connectionKey: string): void {
  distrustUpstreamToken(connectionKey);
  distrustMintedToken(connectionKey);
}
