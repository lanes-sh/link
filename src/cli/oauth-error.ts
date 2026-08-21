/**
 * The one error type the OAuth flow throws.
 *
 * Its own file because both halves of the flow raise it — the listener in
 * `oauth.ts` and the exchange in `oauth-exchange.ts` — and having either import
 * the other would be a cycle for the sake of one class.
 */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}
