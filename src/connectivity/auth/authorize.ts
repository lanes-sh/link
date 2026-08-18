import type { ProviderRegistry } from '#registry';
import type { SecretStore } from '#secrets';
import { attachApiKey } from './api-key/index.ts';
import { attachBasic } from './basic/index.ts';
import { attachBearer } from './bearer/index.ts';
import { credentialResolver } from './resolve.ts';

/**
 * Attach whatever the manifest's auth method requires to an outbound request.
 *
 * Connectors never see a raw credential: they hand core a request and get an
 * authorised one back. A pure function of the resolved shape, so there is one
 * place that reads the store (`resolve.ts`) and one that decides what a request
 * looks like.
 */
export function requestAuthorizer(
  registry: ProviderRegistry,
  secrets: SecretStore,
): (providerId: string, connectionId: string, request: Request) => Promise<Request> {
  const resolve = credentialResolver(registry, secrets);

  return async (providerId, connectionId, request) => {
    const credential = await resolve(providerId, connectionId);
    if (credential.kind === 'none') return request;

    const authorised = new Request(request, { headers: new Headers(request.headers) });

    switch (credential.kind) {
      case 'oauth':
        authorised.headers.set('authorization', `Bearer ${credential.accessToken}`);
        break;
      case 'bearer':
        attachBearer(credential, authorised);
        break;
      case 'basic':
        attachBasic(credential, authorised);
        break;
      case 'api_key': {
        // The only method that may need to rebuild the request rather than add
        // a header, because a key in the query string changes the URL.
        const relocated = attachApiKey(credential, authorised, request);
        if (relocated) return relocated;
        break;
      }
    }

    return authorised;
  };
}
