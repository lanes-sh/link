import type { VerifyOutcome } from '#connectivity';

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
  /** The strategy's own verifier, where the vendor signs its replies. */
  readonly strategy?: ((response: Response) => Promise<VerifyOutcome | void>) | undefined;
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

    if (response.status !== 401 || asked) return outcome ?? undefined;

    asked = true;
    options.distrust(options.connectionKey);
    return { retry: true };
  };
}
