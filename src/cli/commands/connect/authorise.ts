import { auth, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/client';
import { CredentialOAuthProvider } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import type { ProviderManifest } from '#connectivity';
import { ConfigDocument } from '../../config-edit.ts';
import { captureOAuthCallback, defaultOpenBrowser, runOAuthFlow } from '../../oauth.ts';
import { ok, progress, style, warn } from '../../output.ts';
import { terminalPrompter, type Prompter } from '../../prompt.ts';
import { describeScopes, shortScope } from '../../scopes.ts';
import { ensureOAuthApp } from './setup.ts';

/**
 * Getting a token, and saying what it will be able to do first.
 *
 * Two paths, because two kinds of upstream: an MCP server publishes metadata
 * worth discovering and the SDK drives it, while a plain REST API announces
 * nothing and the manifest has to name its endpoints.
 */

export function oauthProviderFor(
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
 * Warn when a manifest's pinned scopes have drifted from the server's.
 *
 * Pinning is deliberate — it stops a vendor widening a grant by editing its own
 * metadata — but a pinned list is a list that can go stale, and both directions
 * of staleness are worth different words:
 *
 * - the server declares a scope we do not request → calls fail, and Google's
 *   servers say only "The caller does not have permission", which points
 *   nowhere near the cause. This is the failure that cost an afternoon.
 * - we request one it no longer declares → probably harmless, possibly a scope
 *   that has been withdrawn; worth seeing, not worth stopping for.
 *
 * Advisory in both directions. Discovery failing must not block a connect that
 * would otherwise work, so a broken probe is silent.
 */
async function reportScopeDrift(pinned: readonly string[], serverUrl: string): Promise<void> {
  let advertised: readonly string[] = [];

  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
    advertised = (metadata as { scopes_supported?: string[] }).scopes_supported ?? [];
  } catch {
    return;
  }

  if (advertised.length === 0) return;

  const missing = advertised.filter((scope) => !pinned.includes(scope));
  const extra = pinned.filter((scope) => !advertised.includes(scope));

  if (missing.length > 0) {
    progress('');
    progress(
      style.dim(
        `${new URL(serverUrl).host} advertises ${missing.length} scope(s) not requested: ` +
          `${missing.map(shortScope).join(', ')}.`,
      ),
    );
    progress(
      style.dim(
        '  Deliberate — an advertised scope is not necessarily a required one, and these are broader than the docs ask for. Worth revisiting only if calls fail on permission.',
      ),
    );
  }

  if (extra.length > 0) {
    progress('');
    progress(style.dim(`Note: ${extra.map(shortScope).join(', ')} is no longer declared by the server.`));
  }
}

/**
 * Show what is about to be granted, and stop on the broad ones.
 *
 * The consent screen that follows lists the same scopes in the vendor's own
 * wording, where "Read, compose, send, and permanently delete all your email"
 * sits in a list of five and reads like boilerplate. This is the same
 * information a step earlier, in our words, with the account still unconnected
 * — the last point where declining costs nothing.
 */
async function confirmScopes(
  manifest: ProviderManifest,
  serverUrl: string,
  prompter: Prompter,
  acceptBroadScopes: boolean,
): Promise<boolean> {
  if (manifest.auth.kind !== 'oauth' || manifest.auth.scopes.length === 0) return true;

  await reportScopeDrift(manifest.auth.scopes, serverUrl);

  const described = describeScopes(manifest.auth.scopes);

  progress('');
  progress(`${manifest.name} will be granted:`);
  for (const { scope, meaning, broad } of described) {
    const name = broad ? style.bold(shortScope(scope)) : shortScope(scope);
    progress(`  ${broad ? '!' : '·'} ${name}${meaning ? style.dim(`  — ${meaning}`) : ''}`);
  }

  if (!described.some((entry) => entry.broad)) {
    progress('');
    return true;
  }

  // Why the broad ones cannot simply be dropped — otherwise the obvious next
  // question is why we ask instead of asking for less.
  progress('');
  progress(
    warn(
      'The marked scopes are broader than this provider needs. Grant them only if you ' +
        'mean to — policy can restrict what an agent calls, but it cannot un-grant a token.',
    ),
  );
  progress(
    style.dim(
      '  Policy still applies: only capabilities you allow are reachable, and every call is audited.',
    ),
  );
  progress('');

  // Answered ahead of time, by a person, in their own shell. The flag is long
  // enough that repeating it is a deliberate act, and it lands in the history of
  // whoever typed it — which is the property that matters, since the point of
  // this gate is that the decision does not originate with the agent.
  if (acceptBroadScopes) {
    progress(style.dim('Broad scopes accepted with --accept-broad-scopes.'));
    return true;
  }

  // Fail closed rather than defaulting to no. A non-interactive run cannot
  // answer, and inventing an answer here would remove the last point at which
  // declining is free — the vendor's own consent screen is next, where the same
  // sentence sits in a list of five and reads like boilerplate.
  if (!prompter.interactive) {
    throw new Error(
      `${manifest.name} asks for scopes broader than it needs, and this run is non-interactive.\n` +
        `  Nothing was authorised. Re-run in a terminal, or add --accept-broad-scopes if you mean to grant them.`,
    );
  }

  return prompter.confirm('Authorise with these scopes?', false);
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
  prompter?: Prompter;
  /** The operator has already said yes to scopes broader than the provider needs. */
  acceptBroadScopes?: boolean;
}): Promise<void> {
  const { manifest, connectionId, credentials, document, changes } = input;
  const prompter = input.prompter ?? terminalPrompter;
  const acceptBroadScopes = input.acceptBroadScopes === true;
  if (manifest.auth.kind !== 'oauth') return;

  if (manifest.auth.registration === 'manual') {
    await ensureOAuthApp(input);
  }

  // A non-MCP connector has nothing to discover auth from: a REST API is a base
  // URL, and where its authorization server lives is not something it
  // announces. So the manifest names the endpoints and we run the flow
  // directly — the same loopback listener, PKCE, and exchange, minus the
  // discovery the SDK would otherwise do for us.
  if (manifest.connector.kind !== 'mcp') {
    await authoriseDirect(input);
    return;
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
  prompter?: Prompter;
  acceptBroadScopes?: boolean;
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

  const [clientId, clientSecret] = app
    ? await Promise.all([
        credentials.get(`${app}/client_id`),
        credentials.get(`${app}/client_secret`),
      ])
    : [null, null];

  if (!clientId || !clientSecret) {
    throw new Error(`No OAuth client stored for "${app}". Run: lanes link connect ${manifest.id}`);
  }

  if (
    !(await confirmScopes(manifest, authorizeUrl, prompter, input.acceptBroadScopes === true))
  ) {
    throw new Error('Cancelled — nothing was authorised.');
  }

  const tokens = await runOAuthFlow({
    authorizeUrl,
    tokenUrl,
    clientId,
    clientSecret,
    scopes: manifest.auth.scopes,
    connectionLabel: manifest.name,
    ...(manifest.auth.authorize_params ? { authorizeParams: manifest.auth.authorize_params } : {}),
    onPrompt: (url) => {
      progress(style.dim('Opening your browser to authorise…'));
      progress(style.dim(`If it did not open: ${url}`));
    },
  });

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
    }),
  );

  progress(ok('authorised'));
}
