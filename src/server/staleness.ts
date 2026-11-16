import type { Generations } from './generations.ts';
import type { Logger } from '#connectivity';

/**
 * When a warm instance re-reads config it was not told about.
 *
 * ## The gap this closes, and why it is not the one ADR-029 measured
 *
 * ADR-029 made an edit publish itself and gave the endpoint an authenticated
 * `POST /reload`, and it considered a poll and declined it in terms: a poll
 * "costs a `list()` on the config prefix per interval per instance, forever, to
 * catch an event that happens a few times a year", where "the notify is exact
 * and free at rest". It named its own weakness in the same breath — **one
 * notify reaches one instance** — and closed it on the error path instead: a
 * call naming a tool this endpoint does not advertise looks exactly like a call
 * naming a tool that appeared a moment ago, so one reload tells them apart.
 *
 * That holds for the case it was written for, a newly connected account, and it
 * cannot reach most of the others. The error path fires only when
 * `Generation.knows` misses, and `knows` asks about a tool *name*, a
 * `lanes_tools_call` capability id, or a `lanes_tools_search` query. A member
 * added or removed moves none of those. Neither does a grant narrowed, a policy
 * denied, or a profile removed — the tool names are identical on both sides of
 * every one of those edits. So the probe never fires for them, and on a target
 * holding several instances the instance that got the POST is correct while its
 * siblings serve the old answer until traffic happens to miss for an unrelated
 * reason. ADR-029's stated weakness is not a rare edge for those rows; it is
 * the ordinary case.
 *
 * ## Why the cost ADR-029 priced is not the cost here
 *
 * The listing it declined is not what this does. `workspaceMembers` is already
 * reading the declared config on every authenticated request's five-second
 * window, because membership is resolved there now (ADR-083) — so the digest of
 * what it read is free, and asking whether it moved is a string comparison.
 * There is no `list()` on the hot path at all.
 *
 * It is also lazy in the way ADR-029 wanted the notify to be: it rides a
 * request, after authentication, so an idle instance pays nothing and "forever"
 * is bounded by traffic rather than by a timer. The notify stays the fast path,
 * exact and free at rest. This is the floor under it.
 *
 * ## One clock, so the two triggers cannot fight
 *
 * Both reasons share `RELOAD_PROBE_MS` and one `probedAt`. `Generations.reload`
 * is already serialised behind its own in-flight promise, so they could not
 * double-*open* a generation; what the shared clock prevents is them
 * double-*provoking* one, and it means a stamp-driven reload leaves the
 * error-path probe nothing to do on the same request — which is correct, since
 * the generation it would be probing is the one that just landed.
 */
export const RELOAD_PROBE_MS = 10_000;

/** Why a reload was provoked. Logged, because the two have different costs. */
export type Reason = 'unknown-tool' | 'config-moved';

export interface Staleness {
  /**
   * Re-read the config, at most once per window.
   *
   * Returns whether a new generation actually landed, so a caller holding a
   * pinned one knows whether to re-acquire.
   */
  reload(reason: Reason): Promise<boolean>;
  /**
   * Re-read it if the declared config has moved since this instance last served
   * a generation built from it. Free when nothing moved, and when no membership
   * pass has run yet.
   */
  catchUp(): Promise<boolean>;
}

export function staleness(options: {
  readonly generations: Generations;
  readonly log: Logger;
  /**
   * Absent on a bind with no member resolver, which then keeps the old behaviour.
   *
   * `digest()` rather than `stamp()`, and the difference is load-bearing:
   * `stamp()` is only as fresh as the last `profilesFor`, and the authenticator
   * chain stops at its first success — so on a workspace whose callers hold
   * static `llk_` tokens the gate and the key link are never reached, this
   * resolver is never asked, and a free read would have been null forever. The
   * question here is about the config, not about whoever happened to call.
   */
  readonly members?: { digest(): Promise<string | null> } | undefined;
  readonly now?: (() => number) | undefined;
}): Staleness {
  const now = options.now ?? Date.now;
  let probedAt = 0;

  /**
   * The digest the generation this instance is serving was built from.
   *
   * Compared against rather than against the previous observation, and the
   * difference matters on failure: a reload that does not land keeps the old
   * generation (`Generations.reload` returns `reloaded: false` and holds it),
   * so advancing this on anything but success would leave the endpoint
   * believing it had caught up and never retrying until the file moved again.
   */
  let serving: string | null = null;

  const reload = async (reason: Reason): Promise<boolean> => {
    if (now() - probedAt < RELOAD_PROBE_MS) return false;
    probedAt = now();

    options.log.info('re-reading config', { reason });
    const result = await options.generations.reload();
    return result.reloaded;
  };

  return {
    reload,

    async catchUp() {
      const observed = (await options.members?.digest()) ?? null;
      if (observed === null) return false;

      // The first observation is taken as what this instance booted with: it
      // opened its generation by reading the same declared config a moment
      // earlier. A change that landed in the gap is picked up by the next one.
      if (serving === null) {
        serving = observed;
        return false;
      }

      if (observed === serving) return false;

      const reloaded = await reload('config-moved');
      if (reloaded) serving = observed;
      return reloaded;
    },
  };
}
