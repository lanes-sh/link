import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { ownerPrincipal, type Principal } from '#auth';
import {
  advertisedNames,
  buildMcpServer,
  matchesQuery,
  mergeCapabilities,
  SURFACE_TOOL_NAMES,
  visibleToolCount,
  type MergedCapability,
  type ProfileRuntime,
} from '#server/mcp';
import type { GenerationDeps, OpenedWorkspace } from './generations.ts';

/** The search, whose own name never says what it is looking for. */
const SEARCH_TOOL = SURFACE_TOOL_NAMES[0]!;

/** The gateway, whose own name never says what it is reaching for. */
const GATEWAY_TOOL = SURFACE_TOOL_NAMES[1]!;

/**
 * One boot's worth of runtimes, and everything derived from them.
 *
 * Immutable in what it serves. The memos inside still recompute on
 * `registry.revision`, because skills can be replaced *within* a generation
 * (ADR-014) — that is the one mutable surface the registry has, and it predates
 * this.
 *
 * Lives beside `generations.ts` rather than in it: that file is about which
 * generation is current and what a reload does to it, and this one is about
 * what a generation holds. Neither needs the other's detail.
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
   * Every capability this generation can reach, advertised or not.
   *
   * Wider than `visible()` under `surface: crunched`, where most of what is
   * reachable is deliberately not advertised — which is exactly the gap the
   * stable-name pair is for, and the reason it needs its own set to check
   * against.
   *
   * The whole merged entry rather than the id alone, because the two halves of
   * that pair ask different questions of it: `lanes_tools_call` names an id and
   * wants a lookup, `lanes_tools_search` names keywords and wants the same
   * ranking the search itself runs.
   */
  readonly reachable: () => ReadonlyMap<string, MergedCapability>;

  /**
   * How many tools this generation advertises (ADR-032).
   *
   * Not `visible().size`: that set spans every reachable capability, and a
   * resource or a prompt is in it without being in `tools/list`.
   */
  readonly toolCount: () => number;

  /**
   * Whether this generation has heard of what a request is asking for.
   *
   * The question a stale instance has to answer before it refuses. It was once
   * the same as "is the tool name advertised", and that stopped being enough
   * when `surface: crunched` made `lanes_tools_call` the way most calls arrive:
   * the gateway's own name is always advertised, so the tool-name check can
   * never fire for it, and a call naming a provider connected since this
   * instance booted was answered "cannot reach" — indistinguishable, to whoever
   * asked, from never having connected it.
   *
   * So the gateway is asked one level down, about the capability it names,
   * against the same reachable set `lanes_tools_call` dispatches from. Not the
   * registry: that holds every capability the catalogue defines whether or not
   * a grant reaches it, so it does not move when a connection is made and would
   * answer "known" for something this instance cannot actually call.
   *
   * Reachability is also what the tool-name check has always meant. A denied
   * capability is not advertised, so calling it by name already provokes one
   * reload before the refusal — policy denial and stale config look identical
   * from here, and resolving that is the probe's whole job. The gateway now
   * gets the same treatment rather than a stricter one.
   *
   * **The search is the half that matters more**, because it comes first. Under
   * `crunched` a client's list holds the owner layer and this pair, so nothing
   * else is *called* until it has been *found* — and a stale instance answering
   * "nothing reachable matches" ends the attempt before a capability id is ever
   * composed. Fixing only the call path would have left the endpoint able to
   * recover from a mistake a model had already been told not to make.
   *
   * A search names no capability, so there is nothing to look up; the question
   * one level down is instead whether anything it holds matches, which is the
   * ranking the search is about to run. `matchesQuery` is that ranking, stopped
   * at the first hit — see `#server/mcp/search-index.ts` for why it must be the
   * same one.
   */
  knows(named: { name: string | null; capability: string | null; query: string | null }): boolean {
    if (named.name === null) return true;
    if (!this.visible().has(named.name)) return false;

    if (named.name === GATEWAY_TOOL) {
      return named.capability === null || this.reachable().has(named.capability);
    }
    if (named.name === SEARCH_TOOL) {
      return named.query === null || matchesQuery(named.query, this.reachable());
    }

    return true;
  }

  /**
   * The surface mode, read from the primary profile and from nowhere else.
   *
   * One endpoint serves several profiles and `tools/list` is their union, so
   * "how much of it is advertised" is a property of the endpoint rather than of
   * a row in it — the granularity ADR-075 named when it declined a
   * per-connection flag, and the same rule `instance.port` already follows.
   *
   * Read per generation rather than pinned at bind time, so a reload picks up a
   * changed value the way it picks up a changed grant. Spread into the options
   * object so `full` passes nothing at all and cannot be told apart from a
   * caller that never heard of the setting.
   */
  #surface(): { surface?: 'crunched' } {
    return this.profiles.get(this.#deps.primary)?.config.surface === 'crunched'
      ? { surface: 'crunched' }
      : {};
  }

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
          [
            ...advertisedNames({
              profiles: this.profiles,
              principal: ownerPrincipal(deps.primary),
              ...this.#surface(),
            }),
            // Advertised without being capabilities, so they are absent from
            // `mergeCapabilities` and have to be added here or every
            // successful call to one is recorded as a refusal.
            ...SURFACE_TOOL_NAMES,
          ],
        ),
    );

    this.reachable = this.#memo(() =>
      mergeCapabilities({ profiles: this.profiles, principal: ownerPrincipal(deps.primary) }),
    );

    this.toolCount = this.#memo(() =>
      visibleToolCount({
        profiles: this.profiles,
        principal: ownerPrincipal(deps.primary),
        ...this.#surface(),
      }),
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
    // The delegation list is part of the key, not just the identity.
    //
    // `Principal` gained `profiles` this release, and `mergeCapabilities` and
    // `forProfile` both read it off the *captured* principal — so two tokens for
    // one subject with different scopes hashed to one entry and whichever
    // authorized first decided what the other could reach. Removing somebody
    // from a profile and re-authorizing then served them the profile they had
    // just lost, or refused one they still had, depending on order.
    const reach = principal.profiles === undefined ? '*' : [...principal.profiles].sort().join(',');
    const key = `${principal.id}\u0000${reach}\u0000${clientLabel ?? ''}`;
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
          ...(this.#deps.remoteClients ? { remoteClients: true } : {}),
          ...this.#surface(),
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
