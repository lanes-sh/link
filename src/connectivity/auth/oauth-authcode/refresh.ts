import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import type { CredentialOAuthProvider } from './provider.ts';

export async function refreshDirectly(
  manifest: ProviderManifest,
  provider: CredentialOAuthProvider,
  tokenUrl: string,
  credentials: SecretStore,
): Promise<unknown> {
  const existing = (await provider.tokens()) as { refresh_token?: string } | undefined;
  const refreshToken = existing?.refresh_token;

  if (!refreshToken) {
    throw new Error(
      `No refresh token stored for ${manifest.id}. Run: lanes link connect ${manifest.id}`,
    );
  }

  const app = manifest.auth.kind === 'oauth' ? manifest.auth.app : undefined;
  const [clientId, clientSecret] = app
    ? await Promise.all([
        credentials.get(`${app}/client_id`),
        credentials.get(`${app}/client_secret`),
      ])
    : [null, null];

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (clientId) body.set('client_id', clientId);
  if (clientSecret) body.set('client_secret', clientSecret);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    // A revoked or expired refresh token is the common case here, and the fix
    // is always the same, so say it rather than surfacing the raw grant error.
    throw new Error(
      `The credential for ${manifest.id} could not be refreshed (${response.status}). ` +
        `Re-authorise with: lanes link connect ${manifest.id}\n${text.slice(0, 200)}`,
    );
  }

  const refreshed = JSON.parse(text) as Record<string, unknown>;

  // Google omits `refresh_token` on a refresh: it is still the original one, and
  // dropping it here would make the *next* refresh fail with no token at all.
  await provider.saveTokens({ refresh_token: refreshToken, ...refreshed } as never);
  return (await provider.tokens()) as unknown;
}
