import { credentialRefForConnection } from '#connectivity';
import type { ProviderRegistry } from '#registry';
import type { SecretStore } from '#secrets';
import { resolveApiKey } from './api-key/index.ts';
import { resolveBasic } from './basic/index.ts';
import { resolveBearer } from './bearer/index.ts';
import { resolveHeader } from './header/index.ts';
import { resolveNone } from './none/index.ts';
import { resolveUpstreamToken } from './oauth-authcode/index.ts';
import { refuseStrategy } from './strategy/index.ts';
import type { ResolvedCredential } from './credential.ts';

/**
 * Reading the store, once, for whichever credential type the manifest declares.
 *
 * One reader feeding two consumers: `authorize.ts` turns the result into
 * headers for anything HTTP-shaped, and a non-HTTP connector takes this
 * directly as a constructor option — IMAP has no `Request` to hand an
 * authorizer and no headers to get back.
 *
 * Each method's own parsing lives in its folder, so what remains here is the
 * dispatch. Adding a credential type is a folder and a case.
 */
export function credentialResolver(
  registry: ProviderRegistry,
  secrets: SecretStore,
): (providerId: string, connectionId: string) => Promise<ResolvedCredential> {
  return async (providerId, connectionId) => {
    const manifest = registry.manifest(providerId);
    if (!manifest) return resolveNone();

    const auth = manifest.auth;
    if (auth.kind === 'none') return resolveNone();

    if (auth.kind === 'oauth') {
      const accessToken = await resolveUpstreamToken(manifest, connectionId, secrets);
      return accessToken ? { kind: 'oauth', accessToken } : resolveNone();
    }

    if (auth.kind === 'strategy') refuseStrategy(auth.strategy);

    const ref = credentialRefForConnection(manifest, connectionId)!;
    const value = await secrets.get(ref);
    if (!value) {
      throw new Error(`No credential stored at ${ref}. Run: lanes link connect ${providerId}`);
    }

    switch (auth.kind) {
      case 'basic':
        return resolveBasic(value, ref, providerId);
      case 'bearer':
        return resolveBearer(value, auth.header);
      case 'header':
        return resolveHeader(value, auth.header);
      case 'api_key':
        return resolveApiKey(value, { header: auth.header, query: auth.query });
    }
  };
}

export type { ResolvedCredential } from './credential.ts';
