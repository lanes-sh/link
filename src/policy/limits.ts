/**
 * Rate limits.
 *
 * These blunt a runaway agent retry loop and protect a vendor's quota. They are
 * NOT a security boundary, and the guarantee table says so: an authorised caller
 * that stays under the limit is not constrained by this module in any way.
 *
 * Limits are per instance. On Cloud Run, which scales horizontally, they are
 * therefore not global — a shared counter store would be needed for that and is
 * deliberately out of scope. Documented rather than silently misleading.
 */

export interface LimitConfig {
  /** Per profile — the endpoint as a whole. */
  readonly requestsPerMinute: number;
  /** Per connection — protects the upstream vendor's quota. */
  readonly upstreamCallsPerMinute: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  requestsPerMinute: 120,
  upstreamCallsPerMinute: 60,
};

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * How many keys one limiter will hold.
 *
 * The bound exists because a key is not always something the endpoint chose. At
 * the HTTP edge a caller is identified by the first `X-Forwarded-For` hop, which
 * on a public deployment is a header a stranger writes — so an unbounded map is
 * an unbounded allocation driven from outside, in a container that now has an
 * explicit memory limit to exceed.
 *
 * Ten thousand is far above any real caller count for a single-user endpoint and
 * far below a problem: a bucket is two numbers and a string key.
 */
const DEFAULT_MAX_KEYS = 10_000;

/**
 * How many go at once when the cap is reached.
 *
 * A batch rather than one, so the sort that finds them is amortised. Evicting a
 * single key per overflow would run an O(n log n) pass on every request once the
 * map is full, which turns the bound into its own denial of service.
 */
const EVICTION_FRACTION = 10;

/**
 * Token bucket, refilled continuously rather than on a fixed window boundary.
 *
 * A fixed window lets a caller spend the whole budget in the last instant of
 * one window and again in the first instant of the next, delivering double the
 * intended rate exactly when a retry storm is worst.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(now: () => number = Date.now, maxKeys: number = DEFAULT_MAX_KEYS) {
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  /** How many callers are currently held. For tests, and for nothing else. */
  get size(): number {
    return this.#buckets.size;
  }

  /**
   * Consume one token. Returns whether the call may proceed, and when the
   * bucket will next have capacity — callers surface that as a retry hint
   * rather than leaving an agent to guess.
   */
  take(key: string, perMinute: number): { allowed: boolean; retryAfterMs: number } {
    if (perMinute <= 0) return { allowed: false, retryAfterMs: 60_000 };

    const now = this.#now();
    const refillPerMs = perMinute / 60_000;
    const existing = this.#buckets.get(key);

    // Before the insert, not after: the cap is on what this map holds, and
    // checking afterwards means it is briefly one over on every overflow.
    if (!existing) this.#makeRoom();

    const bucket = existing ?? { tokens: perMinute, lastRefill: now };

    bucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.lastRefill) * refillPerMs);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
    }

    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * Drop idle buckets so a long-lived process does not accumulate keys forever.
   *
   * Public because it reads as the obvious lever, and because the tests drive it
   * directly. It is **not** what bounds the map, and nothing's correctness may
   * depend on a caller remembering it: for most of this file's life nothing did
   * call it, `edge.ts` claimed idle callers were dropped, and the map grew for
   * as long as the process lived. `#makeRoom` is the bound now, and it runs on
   * the insert path where it cannot be forgotten.
   */
  prune(idleMs = 300_000): void {
    const cutoff = this.#now() - idleMs;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lastRefill < cutoff) this.#buckets.delete(key);
    }
  }

  /**
   * Make space for one more key, if the map is full.
   *
   * Idle callers first, because dropping one costs nothing — a bucket that has
   * not been touched in five minutes has refilled to full, so re-creating it
   * gives back exactly what was discarded.
   *
   * Only when that is not enough does this evict a live caller, oldest first by
   * last use. That *does* forgive whatever the evicted caller had spent, which
   * is the honest cost of a bounded map: an attacker who can mint ten thousand
   * distinct keys can push their own bucket out and start again. What they
   * cannot do is grow the map, and on the paths this limiter guards there is a
   * second bucket keyed on nothing at all — see `edge.ts` — which is the one
   * that holds when the per-caller key is worthless.
   */
  #makeRoom(): void {
    if (this.#buckets.size < this.#maxKeys) return;

    this.prune();
    if (this.#buckets.size < this.#maxKeys) return;

    const oldest = [...this.#buckets.entries()]
      .sort((a, b) => a[1].lastRefill - b[1].lastRefill)
      .slice(0, Math.max(1, Math.ceil(this.#maxKeys / EVICTION_FRACTION)));

    for (const [key] of oldest) this.#buckets.delete(key);
  }
}
