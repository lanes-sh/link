/**
 * What an authorization step decided, before it is HTTP.
 *
 * Its own file because both halves of the flow produce one — the browser leg in
 * `server.ts` and the grant in `grant.ts` — and a shared type that lives in
 * either would make the other import it, which is a cycle rather than a
 * dependency.
 */
export type OAuthResult =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'redirect'; readonly location: string }
  /**
   * Show this to whoever is at the browser.
   *
   * The only page this server renders now. There was a second — the approval
   * form that asked for the endpoint token — and its removal is the point of
   * ADR-062: nothing on loopback asks for a credential any more, so there is
   * nothing there worth phishing.
   */
  | { readonly kind: 'error'; readonly status: number; readonly message: string };

export function invalid(error: string, description: string): OAuthResult {
  // RFC 6749 codes exactly. A client refreshing on a 401 branches on
  // `invalid_grant` specifically; anything else and it retries forever or gives
  // up without re-authorising.
  return { kind: 'json', status: 400, body: { error, error_description: description } };
}
