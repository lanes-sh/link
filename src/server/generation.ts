import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { ownerPrincipal, type Principal } from '#auth';
import {
  buildMcpServer,
  toolNameFor,
  visibleCapabilities,
  visibleToolCount,
  type ProfileRuntime,
} from '#server/mcp';
import type { GenerationDeps, OpenedWorkspace } from './generations.ts';

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
          ...(this.#deps.remoteClients ? { remoteClients: true } : {}),
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
