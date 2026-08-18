import { auth } from '@modelcontextprotocol/client';
import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import { CredentialOAuthProvider, upstreamAccessToken } from './provider.ts';
import { refreshDirectly } from './refresh.ts';

/**
 * OAuth 2.0 authorization code — the three-legged flow, with a refresh token
 * held in the secret store.
 *
 * The only method here that needs more than a stored string: a browser round
 * trip at connect time, a refresh on every use, and two different ways to run
 * that refresh depending on whether the provider has a metadata document.
 *
 * The other flows the credential-type list names — JWT bearer, client
 * credentials — are sibling folders that do not exist yet. See ../README.md.
 */

export async function resolveUpstreamToken(
  manifest: ProviderManifest,
  connectionId: string,
  credentials: SecretStore,
): Promise<string | null> {
  if (manifest.auth.kind !== 'oauth') return null;

  const provider = new CredentialOAuthProvider({
    manifest,
    connectionId,
    credentials,
    scopes: manifest.auth.scopes,
  });

  // Where to re-run discovery from, if a refresh needs it. An `http` connector
  // has no metadata document, so it names its authorization server in the
  // manifest instead — and the refresh below only ever exchanges a stored
  // refresh token, which needs the token endpoint and nothing else.
  const endpoint =
    manifest.connector.kind === 'mcp' ? manifest.connector.endpoint : manifest.auth.token_url;

  return upstreamAccessToken({
    connectionKey: `${manifest.id}.${connectionId}`,
    provider,
    async refresh(target) {
      // No browser here on purpose: this path runs while serving requests, and
      // a refresh that silently opened one would be both useless and alarming.
      // If re-consent is genuinely needed the provider throws with the command
      // that fixes it.
      if (!endpoint) throw new Error(`Provider "${manifest.id}" declares no token endpoint.`);

      // A non-MCP provider refreshes directly. The SDK's `auth()` wants to
      // rediscover the authorization server first, which a REST API does not
      // describe — it fails with "prepareTokenRequest() or authorizationCode is
      // required", which says nothing about the real problem. Exchanging a
      // stored refresh token needs the token endpoint and the client, and
      // nothing else.
      if (manifest.connector.kind !== 'mcp') {
        return (await refreshDirectly(manifest, target, endpoint, credentials)) as never;
      }

      await auth(target as never, { serverUrl: endpoint });
      return (await target.tokens()) as never;
    },
  });
}
