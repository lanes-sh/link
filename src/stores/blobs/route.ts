import { containedKey, type BlobKey, type BlobMetadata, type BlobStore } from './index.ts';

/**
 * Sending part of a store's key space somewhere else.
 *
 * `scopeBlobStore` narrows a store to a namespace; this one splits a store
 * between backends. A key under a route's prefix is served by that route's
 * store — which is rooted *at* the prefix, so the prefix is stripped on the way
 * in and put back on the way out — and every other key falls through to the
 * base.
 *
 * It exists for one shape and it is worth naming it, because the alternative
 * was much larger. A profile's memory is not addressed by a name anything
 * declares: core scopes the profile's blob root to `<provider>/<connection>`
 * inside `buildProviderContext`, and `lanes link memory` reaches the same bytes
 * by calling the same two functions. So "put memory somewhere else" is not a
 * question the provider, the dispatcher, or the CLI can be asked — it is a
 * property of the store all three were handed. Routing the root means none of
 * them changes, and none of them can disagree about where an entry went.
 *
 * A route's store is expected to enforce its own containment: it is a
 * `BlobStore` like any other, and the base's rules do not travel across the
 * boundary.
 */

export interface BlobRoute {
  /**
   * The key prefix this route claims, ending in `/`.
   *
   * Directory-shaped on purpose. A bare `memory` would also claim
   * `memory-archive/x`, and a store that quietly swallows a neighbouring
   * namespace is the kind of bug that surfaces as missing data rather than as
   * an error.
   */
  readonly prefix: string;
  /** A store rooted at `prefix`, so it never sees the prefix itself. */
  readonly store: BlobStore;
}

export function routeBlobStore(base: BlobStore, routes: readonly BlobRoute[]): BlobStore {
  if (routes.length === 0) return base;

  const normalised = routes.map((route) => {
    if (route.prefix.length === 0) {
      throw new Error('A blob route prefix must not be empty — that is the base store.');
    }
    return { ...route, prefix: route.prefix.endsWith('/') ? route.prefix : `${route.prefix}/` };
  });

  /**
   * Which store owns this key, and what it calls it.
   *
   * Contained first, so `memory/../elsewhere.md` is judged by where it lands
   * rather than by how it is spelled — routing on the raw string would let a
   * traversal pick its own backend, which is a weaker answer than either store
   * gives on its own.
   */
  const routeFor = (key: BlobKey): { store: BlobStore; key: BlobKey } => {
    const resolved = containedKey(key);
    for (const route of normalised) {
      if (resolved.startsWith(route.prefix)) {
        return { store: route.store, key: resolved.slice(route.prefix.length) };
      }
    }
    return { store: base, key };
  };

  return {
    async put(key, data, options) {
      const to = routeFor(key);
      return to.store.put(to.key, data, options);
    },

    async get(key) {
      const to = routeFor(key);
      return to.store.get(to.key);
    },

    async has(key) {
      const to = routeFor(key);
      return to.store.has(to.key);
    },

    async delete(key) {
      const to = routeFor(key);
      return to.store.delete(to.key);
    },

    /**
     * Merge the listings, with routed keys removed from the base's.
     *
     * Three cases, and the middle one is the one that is easy to miss: a
     * listing prefix *inside* a route belongs wholly to that route, a listing
     * prefix *containing* a route has to include everything that route holds,
     * and a listing that touches neither is the base's alone. Sorted at the end
     * because callers rely on it — `skillFingerprint` sorts its own output, but
     * `loadProfileSkills` reads the listing in order.
     */
    async list(prefix) {
      const asked = prefix ?? '';

      for (const route of normalised) {
        if (asked.startsWith(route.prefix)) {
          const inner = await route.store.list(asked.slice(route.prefix.length));
          return inner.map((entry) => ({ ...entry, key: `${route.prefix}${entry.key}` }));
        }
      }

      const results: BlobMetadata[] = (await base.list(asked)).filter(
        (entry) => !normalised.some((route) => entry.key.startsWith(route.prefix)),
      );

      for (const route of normalised) {
        if (!route.prefix.startsWith(asked)) continue;
        for (const entry of await route.store.list()) {
          results.push({ ...entry, key: `${route.prefix}${entry.key}` });
        }
      }

      return results.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
