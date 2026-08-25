import type { Logger } from '#connectivity';
import { clearUpstreamTokens } from '#connectivity/auth/index.ts';
import type { ProfileRuntime } from '#server/mcp';
import { Generation } from './generation.ts';

/**
 * Which generation is current, and the reload that replaces it.
 *
 * The generation itself — one boot's runtimes and every cache derived from
 * them — is `generation.ts`. Split when this file outgrew its budget, along the
 * seam it already had: what a generation *is* is a different subject from when
 * one is swapped, and only the latter needs to know about reloading at all.
 *
 * This is a different subject from what an HTTP request does, which is why it
 * is not in `index.ts`. The endpoint used to hold one map of profile runtimes
 * for the life of the process, and every cache derived from it — the handler
 * memo, the visible-tool set, the capability-id list, the skill poll clock —
 * hung off the request handler beside it. That was correct while the map could
 * not change.
 *
 * It can now: `connect` writes a connection and tells the endpoint, and the
 * endpoint re-reads its whole config (ADR-029). Once the map can be replaced,
 * every one of those caches becomes a separate thing that must be invalidated
 * at exactly the same moment, and the handler memo is the one that bites — it
 * closes over the map *inside* `buildMcpServer`, so a stale entry serves the
 * old config from a handler that looks fresh.
 *
 * So the caches move onto the generation they were derived from. Replacing the
 * generation replaces all of them together, and nothing stale can outlive its
 * generation by construction rather than by remembering to clear it.
 *
 * ## Why a generation is not closed when it is replaced
 *
 * `Runtime.close()` ends connector sessions and writes the audit log's end
 * marker. A request that started against a generation is still using both, and
 * requests do not stop at a reload — so a generation is *retired* when it is
 * replaced and closed when its last in-flight request has drained. `fetch`
 * pins one for its whole lifetime; that pin is the reference count.
 */

/** A workspace opened and reconciled: what it serves, and how to let it go. */
export interface OpenedWorkspace {
  readonly profiles: ReadonlyMap<string, ProfileRuntime>;
  close(): Promise<void>;
}

/** Re-open and re-reconcile the whole workspace. Supplied by `endpoint.ts`. */
export type OpenWorkspace = () => Promise<OpenedWorkspace>;

export interface GenerationDeps {
  /** Which profile's principal the visible-tool set is computed for. */
  readonly primary: string;
  readonly log: Logger;
  readonly version?: string | undefined;
  /** Whether an authorization surface is published. See `BuildServerOptions`. */
  readonly remoteClients?: boolean | undefined;
}

/** What a reload did, as the `/reload` route reports it. */
export interface ReloadResult {
  readonly reloaded: boolean;
  readonly epoch: number;
  readonly profiles: readonly string[];
  /**
   * How many tools the generation now serving advertises (ADR-032).
   *
   * What `connect` prints: the edit landing and the surface a client sees are
   * different events, and the gap is where a stale tool list hides.
   */
  readonly tools: number;
  /** Why it did not reload. Absent on success. */
  readonly reason?: string;
}

/**
 * The current generation, and the reload that replaces it.
 *
 * One instance per endpoint. `acquire`/`release` bracket a request; `reload`
 * swaps in a freshly opened workspace and retires the one it replaced.
 */
export class Generations {
  #current: Generation;
  #epoch: number;
  #inFlight: Promise<ReloadResult> | null = null;

  readonly #open: OpenWorkspace;
  readonly #deps: GenerationDeps;

  constructor(initial: OpenedWorkspace, open: OpenWorkspace, deps: GenerationDeps) {
    this.#epoch = 0;
    this.#current = new Generation(0, initial, deps);
    this.#open = open;
    this.#deps = deps;
  }

  /**
   * Record what the current generation advertises.
   *
   * Called by the endpoint once the socket is bound, not from the constructor
   * where it used to be: a `serving` record written before `serve()` returns is
   * a claim about an endpoint that a failed bind means never served, and a
   * crash-looping revision emitted one per attempt. `advertising` rather than
   * `serving` because the container writes its own `serving <url>` to the same
   * stream, and one word covering two different records is a filter that
   * returns both and distinguishes neither.
   *
   * The boot emission is the more useful of the two: a fresh revision comes up
   * holding whatever config held at deploy time — often one `setup.main` and
   * two tools — and a client registered in that window keeps what it was
   * handed. This is what makes that window visible afterwards (ADR-032).
   */
  announce(): void {
    this.#deps.log.info('advertising', {
      epoch: this.#current.epoch,
      tools: this.#current.toolCount(),
    });
  }

  get current(): Generation {
    return this.#current;
  }

  /** Pin the current generation for the life of one request. */
  acquire(): Generation {
    const generation = this.#current;
    generation.pin();
    return generation;
  }

  release(generation: Generation): Promise<void> {
    return generation.unpin();
  }

  /**
   * Re-open the workspace and serve what it now says.
   *
   * Serialised behind one in-flight promise: two concurrent `/reload` calls
   * must not each open a full set of runtimes, and the second caller wants the
   * same answer as the first rather than a second reload of the same edit.
   *
   * A failure is reported, never fatal. A config file caught mid-write, a
   * bucket that briefly refuses a read, a profile someone is editing by hand —
   * none of those are a reason to take down an endpoint that is serving. The
   * previous generation stays current and the caller is told why.
   */
  reload(): Promise<ReloadResult> {
    if (this.#inFlight) return this.#inFlight;

    const attempt = this.#reload().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = attempt;
    return attempt;
  }

  async #reload(): Promise<ReloadResult> {
    const previous = this.#current;

    let opened: OpenedWorkspace;
    try {
      opened = await this.#open();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#deps.log.warn('could not reload config', { message: reason });
      return {
        reloaded: false,
        epoch: previous.epoch,
        profiles: previous.names(),
        tools: previous.toolCount(),
        reason,
      };
    }

    this.#epoch += 1;
    this.#current = new Generation(this.#epoch, opened, this.#deps);

    // Past this line the reload has *landed*: the new generation is what
    // requests get. Everything below is tidying and reporting, and none of it
    // can un-land the swap — so a throw here must not be reported as a failed
    // reload. It would be: `/reload` has no try/catch of its own, so the
    // exception becomes a 500, and `connect` reads that as "saved, and the
    // endpoint will serve this when it next starts" for config the endpoint is
    // already serving. `previous.retire()` closes the audit log, which on a
    // cloud target is a network write, so this is reachable rather than
    // theoretical.
    try {
      // Module-global and keyed per connection, so it survives a reload that
      // replaced everything else. Re-connecting `<provider>.<id>` to a different
      // account would otherwise serve the previous account's access token until
      // it expired — up to an hour after the config said otherwise. Unchanged
      // connections pay one refresh.
      clearUpstreamTokens();

      // After the swap: a request arriving during the retire already gets the
      // new generation, and this only waits on requests that started before it.
      await previous.retire();
    } catch (error) {
      this.#deps.log.error('reload landed, but retiring the previous generation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const tools = this.#current.toolCount();

    // The only record of what the endpoint advertises: `tools/list` is neither
    // logged nor audited, so nothing else could tell a generation serving two
    // tools from one serving forty. Once per reload, on a memoised read.
    this.#deps.log.info('advertising', { epoch: this.#current.epoch, tools });

    return {
      reloaded: true,
      epoch: this.#current.epoch,
      profiles: this.#current.names(),
      tools,
    };
  }

  /** Close whatever is current. In-flight pins are not waited on. */
  close(): Promise<void> {
    return this.#current.close();
  }
}
