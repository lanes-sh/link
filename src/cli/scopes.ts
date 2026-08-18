import { SCOPE_MEANINGS } from '#providers/scopes.ts';

/**
 * Saying out loud what a connection is about to be granted.
 *
 * Least privilege is the goal, and a vendor's *advertised* scope list is not the
 * same as its required one. Google's Gmail MCP server advertises five, including
 * `mail.google.com` — read, send, and permanently delete — while its own
 * documentation names two. Granting all five was tested against the real service
 * and changed nothing, so the two are what we ask for.
 *
 * Where a grant does have to be broad, it must not happen quietly: an over-broad
 * grant is invisible after the fact, and a consent screen listing five
 * Google-worded scopes is not where someone discovers that "Gmail" meant
 * permanent delete. We print it first, in plain words, and make the broad ones an
 * explicit yes.
 *
 * What each scope *means* is the provider's knowledge and lives in its folder
 * (`#providers/scopes.ts` merges the contributions). This file is the rendering,
 * and it works the same for a provider it has never heard of: a scope missing
 * from the table is printed unannotated rather than mis-described — silence is
 * the safe failure here.
 */

export interface ScopeDescription {
  readonly scope: string;
  /** Plain-English meaning, where the provider supplied one. */
  readonly meaning?: string;
  /** Unrestricted access to the service, or close enough to warrant a stop. */
  readonly broad: boolean;
}

export function describeScope(scope: string): ScopeDescription {
  const known = SCOPE_MEANINGS[scope];
  return {
    scope,
    ...(known?.meaning ? { meaning: known.meaning } : {}),
    broad: known?.broad === true,
  };
}

export function describeScopes(scopes: readonly string[]): ScopeDescription[] {
  return scopes.map(describeScope);
}

/**
 * Shorten a scope for display; the full value is still what is requested.
 *
 * Generic on purpose. The last path segment after `/auth/` is the convention
 * every OAuth vendor that uses URL-shaped scopes follows, and anything else is
 * left alone rather than guessed at.
 */
export function shortScope(scope: string): string {
  const match = scope.match(/\/auth\/([^/]+)$/);
  if (match?.[1]) return match[1];

  // A bare host with nothing after it — `https://mail.google.com/` — reads
  // better without the scheme, and there is nothing else to take.
  const url = URL.parse?.(scope);
  if (url && (url.pathname === '/' || url.pathname === '')) return url.host;

  return scope;
}
