import type { ProviderManifest } from '#connectivity';
import type { SecretStore } from '#secrets';
import { BROKERED, BrokerError, brokerRefresh } from './broker.ts';
import type { CredentialOAuthProvider } from './provider.ts';

/** What a stored OAuth credential carries beyond the tokens themselves. */
interface StoredTokens {
  readonly refresh_token?: string;
  /** An identity assertion, presented to the broker so it knows whose refresh this is. */
  readonly id_token?: string;
  /** Which client minted this. Absent means the profile's own. */
  readonly authorized_via?: string;
}

export async function refreshDirectly(
  manifest: ProviderManifest,
  provider: CredentialOAuthProvider,
  tokenUrl: string,
  credentials: SecretStore,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<unknown> {
  const existing = (await provider.tokens()) as StoredTokens | undefined;
  const refreshToken = existing?.refresh_token;

  if (!refreshToken) {
    throw new Error(
      `No refresh token stored for ${manifest.id}. Run: lanes link connect ${manifest.id}`,
    );
  }

  const auth = manifest.auth.kind === 'oauth' ? manifest.auth : undefined;

  // Which client issued this token is a property of the *token*, not of the
  // profile. A refresh token minted by one client is refused by another, so an
  // operator who registers a client of their own after the fact must not drag
  // existing connections onto it — they keep refreshing where they were issued,
  // and only a fresh `connect` moves them.
  const broker = auth?.broker;
  const brokered = broker !== undefined && existing?.authorized_via === BROKERED;

  const refreshed = brokered
    ? await viaBroker(manifest, broker.url, refreshToken, existing, fetchImpl)
    : await viaStoredClient(manifest, auth?.app, tokenUrl, refreshToken, credentials, fetchImpl);

  // `existing` first, so what the response does not mention survives it. Neither
  // the vendor nor the broker echoes `refresh_token`, `id_token`, or
  // `authorized_via` unless there is a new one, and dropping any of the three
  // would leave the *next* refresh with no token, no attribution, or pointed at
  // the wrong client.
  await provider.saveTokens({ ...existing, ...refreshed, refresh_token: refreshToken } as never);
  return (await provider.tokens()) as unknown;
}

async function viaBroker(
  manifest: ProviderManifest,
  url: string,
  refreshToken: string,
  existing: StoredTokens,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  try {
    return (await brokerRefresh(
      url,
      { refreshToken, ...(existing.id_token ? { idToken: existing.id_token } : {}) },
      fetchImpl,
    )) as Record<string, unknown>;
  } catch (cause) {
    // This surfaces to an agent in the middle of a request, so it must name a
    // command the *owner* runs and nothing the agent could mistake for its own
    // next step. Same shape as the stored-client message below, deliberately:
    // where the credential came from is not the reader's problem here.
    const notice = cause instanceof BrokerError && cause.notice ? `\n${cause.notice}` : '';
    throw new Error(
      `The credential for ${manifest.id} could not be refreshed. ` +
        `Re-authorise with: lanes link connect ${manifest.id}\n${String(
          cause instanceof Error ? cause.message : cause,
        ).slice(0, 200)}${notice}`,
    );
  }
}

async function viaStoredClient(
  manifest: ProviderManifest,
  app: string | undefined,
  tokenUrl: string,
  refreshToken: string,
  credentials: SecretStore,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  const [clientId, clientSecret] = app
    ? await Promise.all([
        credentials.get(`${app}/client_id`),
        credentials.get(`${app}/client_secret`),
      ])
    : [null, null];

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (clientId) body.set('client_id', clientId);
  if (clientSecret) body.set('client_secret', clientSecret);

  const response = await fetchImpl(tokenUrl, {
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

  return JSON.parse(text) as Record<string, unknown>;
}
