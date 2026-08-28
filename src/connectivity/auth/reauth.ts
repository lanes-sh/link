/**
 * The one failure a person has to fix, told apart from every other one.
 *
 * A stored credential stops working for two very different reasons, and until
 * this existed they arrived as the same `Error`:
 *
 *   - the grant is gone — revoked, or expired because the client's publishing
 *     status expires refresh tokens on a timer. Nothing retries its way out of
 *     this; somebody has to sign in again.
 *   - the token endpoint had a bad afternoon — a 502, a reset connection, DNS.
 *     Retrying is exactly right, and telling the owner to re-authorise would be
 *     a lie that costs them a consent screen.
 *
 * Both used to read as "could not be refreshed", so anything trying to *report*
 * connection health had to match on the message text. That is why this is a
 * class and not a string: `auth.ts` classifies on `instanceof`, and the messages
 * stay free to be rewritten for whoever is reading them.
 *
 * The message is deliberately unchanged from what each throw site said before —
 * this is a widening, not a rewrite. What is new is that the type now carries
 * *which* connection, so a caller holding several can say which one to fix
 * without parsing the sentence.
 */
export class ReauthRequired extends Error {
  /** `provider.id`, e.g. `gmail.main`. The addressing form used everywhere. */
  readonly connectionKey: string;

  constructor(connectionKey: string, message: string) {
    super(message);
    this.name = 'ReauthRequired';
    this.connectionKey = connectionKey;
  }
}

/**
 * Whether an HTTP status from a token endpoint means the grant itself is dead.
 *
 * 4xx is the authorization server saying no to *this credential* — `invalid_grant`
 * for a revoked or expired refresh token, `invalid_client` for a client that no
 * longer exists. Signing in again is the fix.
 *
 * 5xx is the server saying no to *everyone*, and 429 is it saying "not now".
 * Neither is a statement about the credential, so neither may be reported as
 * needing a human. 429 sits in the 4xx range and is excluded for that reason.
 */
export function statusMeansGrantIsDead(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}
