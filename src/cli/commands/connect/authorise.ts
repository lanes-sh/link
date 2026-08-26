import { auth, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/client';
import { CredentialOAuthProvider } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import type { ProviderManifest } from '#connectivity';
import { ConfigDocument } from '../../config-edit.ts';
import { captureOAuthCallback, defaultOpenBrowser, runOAuthFlow } from '../../oauth.ts';
import { ok, progress, style, warn } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { describeScopes, shortScope } from '../../scopes.ts';
import { BROKERED, BrokerError } from '#connectivity/auth/index.ts';
import { brokerExchangeVia } from '../../oauth-exchange.ts';
import { brokeredScopes, hostedClientRefusal, resolveOAuthClient } from './client.ts';
import { confirmScopes } from './scopes-gate.ts';
import { ensureOAuthApp } from './setup.ts';

/**
 * Getting a token, and saying what it will be able to do first.
 *
 * Two paths, because two kinds of upstream: an MCP server publishes metadata
 * worth discovering and the SDK drives it, while a plain REST API announces
 * nothing and the manifest has to name its endpoints.
 */

/**
 * No longer exported. `#cli` used to reach for this to answer "what token does
 * this manifest authenticate with", which is a question the auth component
 * owns — and answering it here is what let a `bearer` manifest slip through
 * returning null. `bearerTokenAsStored` is the answer now; this builds the
 * provider for the browser flow below, which is the one thing it is for.
 */
function oauthProviderFor(
  manifest: ProviderManifest,
  connectionId: string,
  credentials: SecretStore,
  redirectUrl?: string,
  openBrowser?: (url: URL) => void,
  state?: string,
): CredentialOAuthProvider {
  return new CredentialOAuthProvider({
    manifest,
    connectionId,
    credentials,
    scopes: manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [],
    ...(redirectUrl ? { redirectUrl } : {}),
    ...(openBrowser ? { openBrowser } : {}),
    ...(state ? { state } : {}),
  });
}

/**
 * Drive the SDK's OAuth flow over a loopback callback.
 *
 * The SDK does discovery, registration, PKCE, and the exchange. We supply
 * storage and a browser — and, for a manual registration, the client the vendor
 * insists the operator supplies.
 */
export async function authorise(input: {
  manifest: ProviderManifest;
  connectionId: string;
  credentials: SecretStore;
  document: ConfigDocument;
  changes: string[];
  /** No connection of this provider exists yet, so its console setup is undone. */
  firstForProvider: boolean;
  /** How the operator spelled the target, so a refusal names a command they typed. */
  target?: string;
  profile: string;
  /** Which OAuth client, when the operator chose one. `undefined` keeps today's precedence. */
  client?: 'own' | 'hosted' | undefined;
  prompter?: Prompter;
  /** The operator has already said yes to scopes broader than the provider needs. */
  acceptBroadScopes?: boolean;
  /** Injected for tests. The broker is the only thing `connect` fetches. */
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const { manifest, connectionId, credentials, document, changes } = input;
  const prompter = input.prompter ?? terminalPrompter;
  const acceptBroadScopes = input.acceptBroadScopes === true;
  if (manifest.auth.kind !== 'oauth') return;

  // `authoriseDirect` owns the client decision now: a brokered provider has
  // nothing to prompt for, and asking first would ask for what it does not need.
  //
  // A non-MCP connector has nothing to discover auth from: a REST API is a base
  // URL, and where its authorization server lives is not something it
  // announces. So the manifest names the endpoints and we run the flow
  // directly — the same loopback listener, PKCE, and exchange, minus the
  // discovery the SDK would otherwise do for us.
  if (manifest.connector.kind !== 'mcp') {
    await authoriseDirect(input);
    return;
  }

  // An MCP provider is always bring-your-own: `defineProvider` refuses a broker
  // on one, because the SDK owns the exchange and there is no seam to route it.
  if (manifest.auth.registration === 'manual') {
    await ensureOAuthApp(input);
  }

  const serverUrl = manifest.connector.endpoint;

  const callback = captureOAuthCallback({ label: manifest.name });

  try {
    const provider = oauthProviderFor(
      manifest,
      connectionId,
      credentials,
      callback.redirectUri,
      (url) => {
        progress(style.dim('Opening your browser to authorise…'));
        progress(style.dim(`If it did not open: ${url.href}`));
        defaultOpenBrowser(url.href);
      },
      callback.state,
    );

    // Request exactly the scopes the manifest declares, and say what they are.
    //
    // Pinning the set matters: left alone the SDK asks for the union of
    // everything the resource advertises, so a vendor could widen a grant by
    // editing its own metadata. But pinning is not the same as narrowing —
    // Google's servers reject a subset of what they advertise, which is why
    // the Gmail and Drive manifests carry the full set rather than the two
    // scopes their docs name. Where we cannot reduce the grant we can at least
    // refuse to make it quietly.
    if (!(await confirmScopes(manifest, serverUrl, prompter, acceptBroadScopes))) {
      throw new Error('Cancelled — nothing was authorised.');
    }

    const scope = manifest.auth.scopes.length > 0 ? manifest.auth.scopes.join(' ') : undefined;

    const first = await auth(provider as never, {
      serverUrl,
      ...(scope ? { scope } : {}),
    });

    if (first === 'AUTHORIZED') {
      progress(ok('already authorised'));
      return;
    }

    const { code, iss } = await callback.wait();

    // `iss` is forwarded for RFC 9207 issuer validation: it is what lets the
    // SDK detect an authorization-server mix-up before redeeming the code.
    // Capturing it and dropping it would silently give up that defence.
    await auth(provider as never, {
      serverUrl,
      authorizationCode: code,
      ...(scope ? { scope } : {}),
      ...(iss ? { iss } : {}),
    });

    if (manifest.auth.registration === 'dynamic') {
      // Worth saying out loud: this is the setup that did not happen.
      changes.push(`registered with ${new URL(serverUrl).host} automatically`);
    }

    progress(ok('authorised'));
  } finally {
    await callback.close();
  }

  void document;
}

/**
 * OAuth against a plain REST API, where there is nothing to discover.
 *
 * `runOAuthFlow` is the M1 path, kept because it turns out to be exactly what a
 * non-MCP provider needs: give it endpoints, a client, and scopes, and it does
 * the loopback listener, PKCE, and the exchange. The MCP branch above uses the
 * SDK instead only because MCP servers publish metadata worth discovering.
 *
 * The token blob is written in the same shape `CredentialOAuthProvider` reads,
 * so refresh, expiry, and staleness reporting all work the same afterwards —
 * a connection should not behave differently at runtime because of how it was
 * authorised.
 */
async function authoriseDirect(input: {
  manifest: ProviderManifest;
  connectionId: string;
  credentials: SecretStore;
  document: ConfigDocument;
  changes: string[];
  firstForProvider: boolean;
  target?: string;
  profile: string;
  client?: 'own' | 'hosted' | undefined;
  prompter?: Prompter;
  acceptBroadScopes?: boolean;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const { manifest, connectionId, credentials } = input;
  const prompter = input.prompter ?? terminalPrompter;
  if (manifest.auth.kind !== 'oauth') return;

  const { authorize_url: authorizeUrl, token_url: tokenUrl, app } = manifest.auth;
  if (!authorizeUrl || !tokenUrl) {
    throw new Error(
      `Provider "${manifest.id}" uses a ${manifest.connector.kind} connector, which cannot discover ` +
        'its authorization server. Its manifest must set auth.authorize_url and auth.token_url.',
    );
  }

  const client = await resolveOAuthClient({
    manifest,
    credentials,
    document: input.document,
    changes: input.changes,
    firstForProvider: input.firstForProvider,
    client: input.client,
    target: input.target ?? manifest.id,
    profile: input.profile,
    ...(input.prompter ? { prompter: input.prompter } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });

  const scopes =
    client.kind === 'brokered'
      ? brokeredScopes(manifest.auth.scopes, client.config).scopes
      : manifest.auth.scopes;

  if (
    !(await confirmScopes(
      manifest,
      authorizeUrl,
      prompter,
      input.acceptBroadScopes === true,
      scopes,
    ))
  ) {
    throw new Error('Cancelled — nothing was authorised.');
  }

  let tokens;
  try {
    tokens = await runOAuthFlow({
      authorizeUrl,
      clientId: client.kind === 'own' ? client.clientId : client.config.clientId,
      ...(client.kind === 'own'
        ? { tokenUrl, clientSecret: client.clientSecret }
        : {
            exchange: brokerExchangeVia({
              url: client.url,
              ...(input.fetch ? { fetch: input.fetch } : {}),
            }),
          }),
      scopes,
      connectionLabel: manifest.name,
      ...(manifest.auth.authorize_params
        ? { authorizeParams: manifest.auth.authorize_params }
        : {}),
      onPrompt: (url) => {
        progress(style.dim('Opening your browser to authorise…'));
        progress(style.dim(`If it did not open: ${url}`));
      },
    });
  } catch (cause) {
    // A broker refusal after consent is worth its own sentence: the operator
    // has already approved the screen, and "nothing was stored" is the fact
    // they need before they decide whether to try again.
    if (cause instanceof BrokerError && client.kind === 'brokered') {
      throw hostedClientRefusal({
        manifest,
        target: input.target ?? manifest.id,
        profile: input.profile,
        operator: manifest.auth.broker?.operator ?? 'this project',
        cause: cause.message,
        ...(cause.notice ? { notice: cause.notice } : {}),
        ...(cause.docsUrl ? { docsUrl: cause.docsUrl } : {}),
        afterConsent: true,
        // A replayed code is not solved by an hour in a console, and the broker
        // is the one that knows which of its refusals are.
        ownClient: cause.ownClient,
      });
    }
    throw cause;
  }

  await credentials.set(
    `${manifest.id}/${connectionId}`,
    JSON.stringify({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      expires_at: Date.now() + tokens.expiresIn * 1000,
      scope: tokens.scope,
      issuer: new URL(authorizeUrl).origin,
      ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
      // Which client issued this, stamped once at connect.
      //
      // A property of the token, not of the profile: a refresh token minted by
      // one client is refused by another, so an operator who registers a client
      // of their own six months from now must not drag existing connections
      // onto it. Absent means "the profile's own", which every credential
      // written before this feature already is.
      ...(client.kind === 'brokered' ? { authorized_via: BROKERED } : {}),
    }),
  );

  progress(ok('authorised'));
}
