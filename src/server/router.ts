import type { Logger } from '#connectivity';
import type { RequestHandler } from './index.ts';

/**
 * Which workspace a request is for, and the handler that serves it.
 *
 * A self-hosted deploy resolves `LANES_LINK_HOME` once at boot and serves one
 * workspace for the life of the process — `container.ts` does exactly that, and
 * nothing here changes it. A Lanes-hosted runtime serves many, so the map from
 * request to workspace has to exist somewhere, and this is the only file that
 * knows there is more than one.
 *
 * It sits *above* `Generations`, which is the equivalent map one level down:
 * that one holds a workspace's runtimes and swaps them on reload, this one
 * holds a workspace's whole handler and lets it go when it has been idle. The
 * layering is deliberate — a reload inside one workspace must not disturb
 * another, and it cannot, because a generation belongs to a handler and a
 * handler belongs to one workspace.
 *
 * **Isolation here is a code path where a self-hosted deploy has a process.**
 * That is the cost of one process serving many workspaces and it is worth
 * naming rather than implying. What holds it up: a handler is built from the
 * workspace it was resolved for and from nothing a request body can influence,
 * a workspace is never handed another's handler, and the two stores that could
 * otherwise be shared are scoped per workspace by their own adapters — the
 * credential namespace in `#deployments/adapters/gcp-secret-manager.ts` and the
 * vault's `keySource` in `#secrets`.
 */

/** How many workspaces stay resident when the caller names no limit. */
const DEFAULT_LIMIT = 64;

export interface WorkspaceRouterOptions {
  /**
   * Which workspace this request is for, or null when it names none.
   *
   * A function rather than a scheme, because how a workspace is named is a
   * deployment's business: a hostname per workspace is what the managed
   * runtime uses, and a test says so in one line instead of constructing one.
   */
  readonly resolve: (request: Request) => string | null;
  /** Build the handler that serves one workspace. Called at most once per resident. */
  readonly open: (workspace: string) => Promise<RequestHandler>;
  /** How many workspaces stay resident. The least recently used is evicted past it. */
  readonly limit?: number;
  readonly log: Logger;
}

interface Resident {
  readonly ready: Promise<RequestHandler>;
  /** Requests currently inside this handler. An evicted resident closes at zero. */
  inFlight: number;
  evicted: boolean;
}

/**
 * The refusal for a request this router cannot place.
 *
 * One answer for two causes — a request naming no workspace, and a workspace
 * that would not open — because the alternative is an oracle. A caller that can
 * tell "no such workspace" from "that one exists but is unreadable right now"
 * can enumerate tenants by watching which hostnames answer differently. ADR-007
 * makes this argument about capabilities; it is the same argument one level up,
 * and the real reason goes to the log rather than to the caller.
 */
function unplaceable(): Response {
  return Response.json({ error: 'not_found' }, { status: 404 });
}

export function createWorkspaceRouter(options: WorkspaceRouterOptions): RequestHandler {
  const limit = options.limit ?? DEFAULT_LIMIT;
  // Insertion-ordered, so the least recently used is simply the first key and
  // touching a resident is a delete followed by a set. A separate recency list
  // would be a second structure to keep in step with this one.
  const residents = new Map<string, Resident>();

  const retire = (resident: Resident): void => {
    resident.evicted = true;
    // A request that started against this handler is still using it, so the
    // close waits for the last one to drain — the same reason a `Generation` is
    // retired rather than closed when a reload replaces it.
    if (resident.inFlight === 0) void closeQuietly(resident);
  };

  const closeQuietly = async (resident: Resident): Promise<void> => {
    try {
      (await resident.ready).close();
    } catch (error) {
      options.log.warn('could not close a workspace', { message: describe(error) });
    }
  };

  const evictOverLimit = (): void => {
    while (residents.size > limit) {
      const oldest = residents.keys().next();
      if (oldest.done) return;
      const resident = residents.get(oldest.value);
      residents.delete(oldest.value);
      if (resident) retire(resident);
    }
  };

  /**
   * The resident for one workspace, opening it if this is the first request.
   *
   * The promise is stored before it resolves, so two requests arriving together
   * for a cold workspace share one `open` rather than building two handlers and
   * leaking whichever loses. A failed open is removed rather than remembered:
   * a bucket that was briefly unreadable must not turn into a workspace that
   * stays broken until the process restarts.
   */
  const acquire = async (workspace: string): Promise<Resident | null> => {
    const existing = residents.get(workspace);
    const resident = existing ?? { ready: options.open(workspace), inFlight: 0, evicted: false };

    // Touch for recency whether it was resident or not; for a new one this is
    // the insert.
    residents.delete(workspace);
    residents.set(workspace, resident);

    try {
      await resident.ready;
    } catch (error) {
      if (residents.get(workspace) === resident) residents.delete(workspace);
      options.log.warn('could not open a workspace', { workspace, message: describe(error) });
      return null;
    }

    // Counted before returning, and before any other request can run: a
    // resident evicted between here and the fetch below must not be closed
    // underneath a request that is already committed to it.
    resident.inFlight += 1;
    evictOverLimit();
    return resident;
  };

  return {
    async fetch(request) {
      const workspace = options.resolve(request);
      if (workspace === null || workspace.length === 0) return unplaceable();

      const resident = await acquire(workspace);
      if (resident === null) return unplaceable();

      try {
        return await (await resident.ready).fetch(request);
      } finally {
        resident.inFlight -= 1;
        if (resident.evicted && resident.inFlight === 0) void closeQuietly(resident);
      }
    },

    async close() {
      const open = [...residents.values()];
      residents.clear();
      await Promise.all(open.map((resident) => closeQuietly(resident)));
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
