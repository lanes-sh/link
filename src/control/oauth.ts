import { OAUTH_NAMESPACE, type KeyValueStore } from '#stores/state';

/**
 * The browser leg of connecting, split in two because a server is not a CLI.
 *
 * `lanes link connect` runs the whole flow in one call: it opens a browser,
 * blocks on a loopback listener, and holds the PKCE verifier on the stack until
 * the code comes back. One process, one flow, nothing to write down.
 *
 * A hosted flow is two separate HTTP requests — the one that asks for a URL and
 * the one the vendor calls back — which may not even reach the same instance.
 * So what the CLI keeps in memory is persisted here, and that is the *whole*
 * difference between the two.
 *
 * **Nothing in `CredentialOAuthProvider` changed to make this work**, which was
 * the constraint rather than a happy accident: it already takes `redirectUrl`
 * and `openBrowser` as options, already carries `state`, and already exposes
 * the verifier and discovery state as methods. The CLI path is untouched.
 */

/**
 * Where a half-finished flow lives.
 *
 * Under the OAuth namespace, which `isWorkspaceNamespace` already routes to the
 * *workspace* store rather than a profile's. That is right for the same reason
 * the endpoint's own authorization-server state is there: an authorization
 * belongs to the workspace, and the profile it will be granted to is a fact
 * recorded inside the flow rather than a reason to file it per profile.
 */
export const PENDING_NAMESPACE = `${OAUTH_NAMESPACE}/pending`;

/** The methods this flow drives on a provider. `CredentialOAuthProvider` has them all. */
export interface AuthFlowProvider {
  redirectToAuthorization(url: URL): Promise<void>;
  saveCodeVerifier(verifier: string): void;
  codeVerifier(): string;
  saveDiscoveryState(state: unknown): void;
  discoveryState(): unknown;
}

export interface AuthFlowDeps {
  readonly kv: KeyValueStore;
  /**
   * The SDK's `auth()`. Injected so this file can be tested without a vendor:
   * every assertion worth making here is about what is persisted and what is
   * refused, and neither needs a real authorization server.
   */
  runAuth(
    provider: AuthFlowProvider,
    options: { serverUrl: string; authorizationCode?: string },
  ): Promise<'AUTHORIZED' | 'REDIRECT'>;
  buildProvider(input: {
    provider: string;
    connectionId: string;
    redirectUrl: string;
    state: string;
    openBrowser: (url: URL) => void;
  }): AuthFlowProvider;
}

export interface BeginInput {
  readonly provider: string;
  readonly connectionId: string;
  /** What the flow authorizes against. */
  readonly serverUrl: string;
  /** Ours, at the api. The vendor calls this back. */
  readonly redirectUrl: string;
  /** Binds the callback to this flow, and is the key everything is stored under. */
  readonly state: string;
}

/** What survives between the two requests. Never a token. */
interface PendingFlow {
  readonly provider: string;
  readonly connectionId: string;
  readonly verifier: string;
  readonly discovery: unknown;
}

export async function beginAuthorization(
  input: BeginInput,
  deps: AuthFlowDeps,
): Promise<{ url: string }> {
  let authorizationUrl: URL | undefined;

  const provider = deps.buildProvider({
    provider: input.provider,
    connectionId: input.connectionId,
    redirectUrl: input.redirectUrl,
    state: input.state,
    // The CLI's implementation launches a browser. Here there is nobody at this
    // machine, so the URL is captured and handed back to whoever asked — an
    // agent puts it in a chat, the dashboard opens it.
    openBrowser: (url) => {
      authorizationUrl = url;
    },
  });

  await deps.runAuth(provider, { serverUrl: input.serverUrl });

  if (authorizationUrl === undefined) {
    // `auth()` answered `AUTHORIZED` without redirecting, which means it found
    // usable tokens already stored. Reported rather than silently succeeding:
    // the caller asked for a URL and there is none, and pretending otherwise
    // would send somebody to an empty page.
    throw new Error(
      `${input.provider} did not need authorising — this connection already holds a credential.`,
    );
  }

  const flow: PendingFlow = {
    provider: input.provider,
    connectionId: input.connectionId,
    verifier: provider.codeVerifier(),
    discovery: provider.discoveryState(),
  };
  await deps.kv.set(PENDING_NAMESPACE, input.state, JSON.stringify(flow));

  return { url: authorizationUrl.toString() };
}

export interface CompleteInput extends BeginInput {
  /** What the vendor handed back. */
  readonly code: string;
}

export async function completeAuthorization(
  input: CompleteInput,
  deps: AuthFlowDeps,
): Promise<boolean> {
  const held = await deps.kv.get(PENDING_NAMESPACE, input.state);
  if (held === null) {
    // Unknown and already-used are one answer, for the reason the API's own
    // pending record gives: a distinguishable "already used" tells somebody
    // replaying a captured callback that they captured a real one.
    throw new Error('There is no authorization in progress for that state.');
  }

  const flow = JSON.parse(held) as PendingFlow;

  const provider = deps.buildProvider({
    provider: flow.provider,
    connectionId: flow.connectionId,
    redirectUrl: input.redirectUrl,
    state: input.state,
    // Unreachable on this leg: `auth()` with a code exchanges rather than
    // redirects. Present because the provider requires one, and throwing is
    // better than a silent no-op if that ever stops being true.
    openBrowser: () => {
      throw new Error('The exchange leg must not redirect.');
    },
  });

  // Restored before the exchange, which is the entire point of the file.
  provider.saveCodeVerifier(flow.verifier);
  if (flow.discovery !== undefined) provider.saveDiscoveryState(flow.discovery);

  // Consumed before the exchange rather than after. A vendor that answers
  // slowly, or a caller that retries, must not get two exchanges out of one
  // authorization — and a failed exchange leaving a dead record is better than
  // a live one somebody can replay.
  await deps.kv.delete(PENDING_NAMESPACE, input.state);

  const result = await deps.runAuth(provider, {
    serverUrl: input.serverUrl,
    authorizationCode: input.code,
  });

  return result === 'AUTHORIZED';
}
