/**
 * Credential types — how we prove who we are to a service.
 *
 * One folder per method, each owning both halves of its job: turning the stored
 * secret into a resolved shape (`resolve*`) and putting that shape on an
 * outbound request (`attach*`). The two dispatchers here are the only files
 * that know the whole set.
 *
 * This is the axis the manifest's `auth:` block selects, and it is deliberately
 * independent of `../transports/` — which is why iCloud can speak IMAP with a
 * password while Gmail speaks HTTP with OAuth, and neither costs the other any
 * code.
 */

export { credentialResolver, type ResolvedCredential } from './resolve.ts';
export { requestAuthorizer } from './authorize.ts';
export { basicCredential } from './basic/index.ts';
export {
  CredentialOAuthProvider,
  clearUpstreamTokens,
  upstreamAccessToken,
  type OAuthProviderOptions,
} from './oauth-authcode/provider.ts';
export { resolveUpstreamToken } from './oauth-authcode/index.ts';
