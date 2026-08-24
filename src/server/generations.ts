import {
  createMcpHandler,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { ownerPrincipal, type Principal } from '#auth';
import type { Logger } from '#connectivity';
import { clearUpstreamTokens } from '#connectivity/auth/index.ts';
import {
  buildMcpServer,
  toolNameFor,
  visibleCapabilities,
  visibleToolCount,
  type ProfileRuntime,
} from '#server/mcp';

/**
 * Which runtimes are current, and when the ones they replaced are closed.
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
}

/**
 * One boot's worth of runtimes, and everything derived from them.
 *
 * Immutable in what it serves. The memos inside still recompute on
 * `registry.revision`, because skills can be replaced *within* a generation
 * (ADR-014) — that is the one mutable surface the registry has, and it predates
 * this.
 */
export class Generation {
  readonly epoch: number;
  readonly profiles: ReadonlyMap<string, ProfileRuntime>;

  readonly #opened: OpenedWorkspace;
  readonly #deps: GenerationDeps;
  readonly #handlers = new Map<string, McpHttpHandler>();

  /** In-flight requests pinned to this generation. */
  #pins = 0;
  /** Replaced by a newer generation, so it closes when the last pin drops. */
  #retired = false;
  #closed = false;

  /** How stale a registry may be before the next request re-reads its skills. */
  static readonly SKILL_POLL_MS = 2_000;
  #polledAt = 0;

  /**
   * Every capability id across every profile, granted or not.
   *
   * Used only to spell a refusal correctly: a tool that exists but is not
   * permitted should appear in the audit under its real id.
   */
  readonly allCapabilityIds: () => readonly string[];

  /**
   * Wire names the endpoint advertises.
   *
   * M1 has a single principal per profile, so this set does not vary by caller.
   * When delegated principals arrive it becomes a per-principal lookup; the call
   * site already reads as one.
   */
  readonly visible: () => ReadonlySet<string>;

  /**
   * How many tools this generation advertises (ADR-032).
   *
   * Not `visible().size`: that set spans every reachable capability, and a
   * resource or a prompt is in it without being in `tools/list`.
   */
  readonly toolCount: () => number;

  constructor(epoch: number, opened: OpenedWorkspace, deps: GenerationDeps) {
    this.epoch = epoch;
    this.profiles = opened.profiles;
    this.#opened = opened;
    this.#deps = deps;

    this.allCapabilityIds = this.#memo(() => [
      ...new Set(
        [...this.profiles.values()].flatMap((runtime) =>
          runtime.registry.capabilities().map(({ id }) => id),
        ),
      ),
    ]);

    this.visible = this.#memo(
      () =>
        new Set(
          visibleCapabilities({
            profiles: this.profiles,
            principal: ownerPrincipal(deps.primary),
          }).map(toolNameFor),
        ),
    );

    this.toolCount = this.#memo(() =>
      visibleToolCount({ profiles: this.profiles, principal: ownerPrincipal(deps.primary) }),
    );
  }

  /** The profile names this generation serves, in declaration order. */
  names(): string[] {
    return [...this.profiles.keys()];
  }

  pin(): void {
    this.#pins += 1;
  }

  /** Drop a pin, closing the generation if it was retired and this was the last. */
  async unpin(): Promise<void> {
    this.#pins -= 1;
    if (this.#retired && this.#pins <= 0) await this.close();
  }

  /** Mark superseded. Closes immediately when nothing is using it. */
  async retire(): Promise<void> {
    this.#retired = true;
    if (this.#pins <= 0) await this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    await Promise.all([...this.#handlers.values()].map((handler) => handler.close()));
    this.#handlers.clear();
    await this.#opened.close();
  }

  /**
   * Work derived from the registries, recomputed when one of them changes.
   *
   * Skills can be replaced in a registry (ADR-014), and a stale `visible()` is
   * not cosmetic: it gates the refusal-audit path, so a newly added skill would
   * be recorded as a refusal on its first `prompts/get` even though the call
   * succeeded.
   */
  #generation(): number {
    return [...this.profiles.values()].reduce(
      (total, runtime) => total + runtime.registry.revision,
      0,
    );
  }

  #memo<T>(compute: () => T): () => T {
    let at = -1;
    let value: T;
    return () => {
      const now = this.#generation();
      if (now !== at) {
        value = compute();
        at = now;
      }
      return value;
    };
  }

  /**
   * Re-read the skills, at most once per poll interval.
   *
   * A skill written elsewhere — `lanes link skills add` in another terminal —
   * cannot announce itself, so the endpoint has to look. Bounded rather than
   * per-request because looking costs a `list()`, which on S3 is a network call.
   * A write made *through* MCP does not wait for this; it refreshes directly.
   */
  async refreshSkills(): Promise<void> {
    const now = Date.now();
    if (now - this.#polledAt < Generation.SKILL_POLL_MS) return;
    this.#polledAt = now;

    await Promise.all(
      [...this.profiles.values()].map(async (runtime) => {
        try {
          await runtime.refreshSkills?.();
        } catch (error) {
          // A skills directory that has gone unreadable, or one skill file
          // someone is mid-edit, must not take the endpoint down with it. The
          // previously loaded skills stay registered.
          this.#deps.log.warn('could not refresh skills', { message: (error as Error).message });
        }
      }),
    );
  }

  /**
   * One handler per (principal, client label), memoised within this generation.
   *
   * The MCP surface depends only on resolved policy, so rebuilding the wiring
   * per request would be pure waste. Reuse is safe because `createMcpHandler`
   * still constructs a fresh server instance per request — what is memoised is
   * the factory wiring, never session state. Memoised *here* rather than on the
   * request handler because the factory closes over this generation's profiles:
   * a handler outliving its generation is the stale-config bug.
   */
  handlerFor(principal: Principal, clientLabel: string | undefined): McpHttpHandler {
    const key = `${principal.id}\u0000${clientLabel ?? ''}`;
    const existing = this.#handlers.get(key);
    if (existing) return existing;

    const handler = createMcpHandler(
      // The principal is closed over rather than read back out of `authInfo`:
      // this handler is already keyed on it, and re-deriving identity from a
      // field the SDK treats as opaque pass-through would create a second
      // source of truth for who is calling.
      (_context: McpRequestContext) =>
        buildMcpServer({
          profiles: this.profiles,
          principal,
          clientLabel,
          ...(this.#deps.version ? { version: this.#deps.version } : {}),
        }),
      {
        onerror: (error: Error) =>
          this.#deps.log.error('mcp handler error', { message: error.message }),
      },
    );

    this.#handlers.set(key, handler);
    return handler;
  }
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

    // The boot half of what `#reload` logs, and the more useful half: a fresh
    // revision comes up with whatever config held at deploy time — often one
    // `setup.main` and two tools — and a client registered in that window keeps
    // what it was handed. This is what makes the window visible afterwards.
    deps.log.info('serving', { epoch: 0, tools: this.#current.toolCount() });
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

    // Module-global and keyed per connection, so it survives a reload that
    // replaced everything else. Re-connecting `<provider>.<id>` to a different
    // account would otherwise serve the previous account's access token until
    // it expired — up to an hour after the config said otherwise. Unchanged
    // connections pay one refresh.
    clearUpstreamTokens();

    // After the swap: a request arriving during the retire already gets the new
    // generation, and this only waits on requests that started before it.
    await previous.retire();

    const tools = this.#current.toolCount();

    // The only record of what the endpoint advertises: `tools/list` is neither
    // logged nor audited, so nothing else could tell a generation serving two
    // tools from one serving forty. Once per reload, on a memoised read.
    this.#deps.log.info('serving', { epoch: this.#current.epoch, tools });

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
