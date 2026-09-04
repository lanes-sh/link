import type { Runtime } from '../runtime.ts';
import { listItems, readContent, readItem } from './browse.ts';
import { createItem, removeItem, writeItem } from './edit.ts';
import { refused, type Answer, type DataSurface } from './surface.ts';

export {
  DATA_STORES,
  DASHBOARD_PRINCIPAL,
  isDataStore,
  isWritableStore,
  type Answer,
  type DataContent,
  type DataDetail,
  type DataItem,
  type DataRefusal,
  type DataScope,
  type DataStoreName,
  type DataSurface,
  type ListOptions,
} from './surface.ts';

/**
 * The owner's data, as one object the read surface can hold.
 *
 * Built over the *generation's* runtimes rather than over the primary one.
 * `ProfileRuntime` carries a registry, a dispatcher and a policy and no store
 * at all, so the map the MCP surface reads cannot answer this — and reading the
 * primary runtime would make every profile but one unreachable on an endpoint
 * whose whole shape is that it serves them all (ADR-009).
 *
 * A thunk, for the reason `ReadDeps.profiles` is one: a reload replaces the
 * runtimes, and a surface closed over the set it was built with would keep
 * serving the generation that has been closed.
 */
export function dataSurface(runtimes: () => ReadonlyMap<string, Runtime>): DataSurface {
  /**
   * The runtime for a named profile, or the refusal for one this endpoint does
   * not serve.
   *
   * `404`, not a default. Defaulting would let a page write to a profile the
   * person at it was not looking at, and naming the profiles that do exist
   * would answer a question the caller has already been answered by `/state`
   * if they are entitled to it.
   */
  function open(profile: string): Answer<Runtime> {
    const runtime = runtimes().get(profile);
    return runtime
      ? { ok: true, value: runtime }
      : refused(404, 'not_found', 'Not found.');
  }

  return {
    async list(options) {
      const runtime = open(options.profile);
      if (!runtime.ok) return runtime;
      return listItems(runtime.value, options.store, options);
    },

    async read(options) {
      const runtime = open(options.profile);
      if (!runtime.ok) return runtime;
      return readItem(runtime.value, options.store, options.id);
    },

    async content(options) {
      const runtime = open(options.profile);
      if (!runtime.ok) return runtime;
      return readContent(runtime.value, options.name);
    },

    async create(options) {
      const runtime = open(options.profile);
      if (!runtime.ok) return runtime;
      return createItem(runtime.value, options.store, options.body);
    },

    async write(options) {
      const runtime = open(options.profile);
      if (!runtime.ok) return runtime;
      return writeItem(runtime.value, options.store, options.id, options.body);
    },

    async remove(options) {
      const runtime = open(options.profile);
      if (!runtime.ok) return runtime;
      return removeItem(runtime.value, options.store, options.id);
    },
  };
}
