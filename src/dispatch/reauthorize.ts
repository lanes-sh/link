import type {
  AuthStrategy,
  AuthStrategyContext,
  CapabilityResult,
  ProviderManifest,
  VerifyOutcome,
} from '#connectivity';

/**
 * Noticing that a call went out with a credential the vendor no longer accepts.
 *
 * A stored `expires_at` is a claim about the future. A token can be rotated,
 * revoked or superseded while our clock still calls it valid, and the only
 * party that knows is the vendor — which says so with a 401 and nothing else.
 * Until that answer could be fed back in, it changed nothing: the next call
 * re-read the same stored token, saw the same unexpired clock, and sent it
 * again. On an hour-long token that is an hour of refusals for a connection
 * whose sibling on the same account is working.
 *
 * This is where the answer is fed back in. It is deliberately not a retry loop:
 * the outcome is handed to the transport, which re-authorises once, so the
 * decision to spend another call lives with the layer that owns the request and
 * the once-only guard lives here, where the verifier is built per invocation.
 *
 * Scoped to oauth because that is the only kind that can be renewed without a
 * person. A basic password or an api key that stops working needs the operator,
 * and retrying it is one more refusal.
 */

export interface VerifierOptions {
  /** `<provider>.<connection>`, as the token cache keys it. */
  readonly connectionKey: string;
  /** Whether this connection's credential is renewable without a person. */
  readonly oauth: boolean;
  /** Stop trusting this connection's token. */
  readonly distrust: (connectionKey: string) => void;
  /**
   * A refusal that outlived the refresh, which means a person is needed.
   *
   * This is the only place the two are distinguishable. A 401 on the first
   * attempt says nothing — a token can be stale for reasons that fix
   * themselves, and usually is. The same answer to a *reissued* token says the
   * grant itself is gone: revoked in the vendor's console, scopes withdrawn,
   * the account removed. Everything downstream sees one 401 and cannot tell,
   * because by then the retry has already happened.
   */
  readonly exhausted?: ((connectionKey: string) => void) | undefined;
  /** The strategy's own verifier, where the vendor signs its replies. */
  readonly strategy?: ((response: Response) => Promise<VerifyOutcome | void>) | undefined;
}

/**
 * The verifier for one invocation, assembled from what the connection is.
 *
 * Here rather than at the call site because every input is about credentials
 * and none is about dispatch: which caches hold this connection's token, which
 * auth kinds can be renewed without a person, and whether the vendor signs its
 * replies. `invoke` should name the connection and be handed the check.
 */
export function verifierFor(options: {
  readonly connectionKey: string;
  readonly manifest: ProviderManifest;
  readonly strategy: AuthStrategy | undefined;
  readonly context: () => AuthStrategyContext;
  readonly distrust: (connectionKey: string) => void;
  readonly exhausted: (connectionKey: string) => void;
}): ((response: Response) => Promise<VerifyOutcome | void>) | undefined {
  const verify = options.strategy?.verify?.bind(options.strategy);

  return responseVerifier({
    connectionKey: options.connectionKey,
    oauth: options.manifest.auth.kind === 'oauth',
    distrust: options.distrust,
    exhausted: options.exhausted,
    ...(verify ? { strategy: (response: Response) => verify(response, options.context()) } : {}),
  });
}

export function responseVerifier(
  options: VerifierOptions,
): ((response: Response) => Promise<VerifyOutcome | void>) | undefined {
  const { strategy } = options;
  if (!options.oauth) return strategy;

  // One per invocation, so this is the natural home for "at most once".
  let asked = false;

  return async (response: Response): Promise<VerifyOutcome | void> => {
    const outcome = await strategy?.(response);
    if (outcome?.retry) return outcome;

    if (response.status !== 401) return outcome ?? undefined;

    // Asked once already, and refused again with the token that refresh
    // produced. Reported rather than retried: a second retry would spend
    // another call to be told the same thing.
    if (asked) {
      options.exhausted?.(options.connectionKey);
      return outcome ?? undefined;
    }

    asked = true;
    options.distrust(options.connectionKey);
    return { retry: true };
  };
}

/**
 * The same failure, said to the party that can act on it.
 *
 * What the vendor returns for a dead grant is written for whoever is reading
 * its logs: `invalid_grant`, `UNAUTHENTICATED`, a link to a console. An agent
 * holding that cannot tell it from the transient case it has no part in, and
 * the honest instruction — stop retrying, ask the owner to reconnect — appears
 * nowhere in it. Prepended rather than replacing, because the vendor's own
 * words are still the evidence for anyone debugging it.
 */
export function reauthResult(connectionKey: string, result: unknown): CapabilityResult {
  const said =
    `${connectionKey} needs to be connected again: the credential was refused, renewed, and ` +
    'refused again, so this is a grant that has ended rather than a token that went stale. ' +
    'Retrying will not help. The owner reconnects it in a terminal; this endpoint cannot.';

  const blocks = (result as { content?: unknown[] }).content ?? [];
  return {
    content: [{ type: 'text' as const, text: said }, ...blocks],
    isError: true,
  } as CapabilityResult;
}
