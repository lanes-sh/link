/**
 * Turning a namespace and a key into an object key, reversibly.
 *
 * Both halves come from callers this module does not control. A provider
 * namespace is `<provider>/<connection>` and its keys are whatever that
 * provider chose; the OAuth server stores under a SHA-256 hex digest; a
 * discovery cache stores under a provider id. Percent-encoding everything
 * outside a small safe set is the only rule that holds for all of them.
 *
 * **Why not the shorter thing.** `gcp-secret-manager.ts` maps `/` to `__` and
 * round-trips to refuse anything ambiguous, which is fine for refs that are
 * already `[a-z0-9_-]` by schema. Keys here are not, so the same trick would
 * have to refuse keys that already work today. In particular `.` must be
 * escaped: a key of `..` is a directory traversal that `encodeURIComponent`
 * would pass through untouched.
 *
 * The namespace keeps its `/` as a real path separator, so a bucket listing is
 * browsable and `keys()` is one prefix list. Each *segment* is still encoded,
 * so a `/` inside a segment cannot forge one.
 */

const SAFE = /^[A-Za-z0-9_-]$/;

export function encodeSegment(segment: string): string {
  let out = '';
  for (const character of segment) {
    if (SAFE.test(character)) {
      out += character;
      continue;
    }
    for (const byte of new TextEncoder().encode(character)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function decodeSegment(segment: string): string {
  return decodeURIComponent(segment);
}

/** `oauth/tokens` becomes `oauth/tokens/`, one encoded path segment each. */
export function namespacePrefix(namespace: string): string {
  if (namespace.length === 0) throw new Error('State namespace must not be empty');
  return `${namespace.split('/').map(encodeSegment).join('/')}/`;
}

export function objectKey(namespace: string, key: string): string {
  if (key.length === 0) throw new Error('State key must not be empty');
  return `${namespacePrefix(namespace)}${encodeSegment(key)}.json`;
}

/**
 * The key a listing entry came from, or `null` if it is not a direct child.
 *
 * Namespaces nest — `oauth` and `oauth/tokens` can both exist — so listing a
 * prefix returns grandchildren too. A namespace that leaked its children's
 * keys would break the isolation `KeyValueStore` exists to provide, so
 * anything below the first level is skipped rather than flattened.
 */
export function keyFromEntry(prefix: string, entryKey: string): string | null {
  if (!entryKey.startsWith(prefix)) return null;

  const remainder = entryKey.slice(prefix.length);
  if (remainder.includes('/') || !remainder.endsWith('.json')) return null;

  return decodeSegment(remainder.slice(0, -'.json'.length));
}
