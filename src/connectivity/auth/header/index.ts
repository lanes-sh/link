import { resolveApiKey } from '../api-key/index.ts';
import type { ResolvedCredential } from '../credential.ts';

/**
 * A raw value in a named header.
 *
 * Distinct from `bearer`, which prefixes `Bearer `. Resolves to the same shape
 * as `api_key` and travels the same attach path, because "put this string in
 * this header" is one behaviour whichever of the two names a manifest picked —
 * and `api_key` is the one that also knows how to put it in the query string.
 *
 * Its own folder rather than an alias in the dispatcher because the *names* are
 * what a manifest declares, and a reader asking "what does `kind: header` do"
 * should find a file rather than a missing case.
 */
export function resolveHeader(value: string, header: string | undefined): ResolvedCredential {
  return resolveApiKey(value, { header });
}
