/**
 * Credential types — how we prove who we are to a service.
 *
 * One folder per method, each owning both halves of its job: turning the stored
 * secret into a resolved shape (`resolve*`) and putting that shape on an
 * outbound request (`attach*`). The dispatchers here are the only files that
 * know the whole set: `resolve.ts` and `authorize.ts` for anything HTTP-shaped,
 * and `token.ts` for a transport that takes a bare token instead of a request.
 *
 * This is the axis the manifest's `auth:` block selects, and it is deliberately
 * independent of `../transports/` — which is why iCloud can speak IMAP with a
 * password while Gmail speaks HTTP with OAuth, and neither costs the other any
 * code.
 */

export { credentialResolver, type ResolvedCredential } from './resolve.ts';
export { requestAuthorizer } from './authorize.ts';
export { basicCredential } from './basic/index.ts';
export { bearerToken, bearerTokenAsStored } from './token.ts';
export {
  CredentialOAuthProvider,
  clearUpstreamTokens,
  upstreamAccessToken,
  type OAuthProviderOptions,
} from './oauth-authcode/provider.ts';
export { resolveUpstreamToken } from './oauth-authcode/index.ts';
export {
  BROKER_ORIGIN_ENV,
  BROKERED,
  BrokerError,
  brokerConfig,
  brokerExchange,
  brokerOriginOverride,
  brokerRefresh,
  type BrokerConfig,
  type BrokerTokens,
} from './oauth-authcode/broker.ts';
