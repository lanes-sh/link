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
 * Token bucket, refilled continuously rather than on a fixed window boundary.
 *
 * A fixed window lets a caller spend the whole budget in the last instant of
 * one window and again in the first instant of the next, delivering double the
 * intended rate exactly when a retry storm is worst.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
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
    const bucket = this.#buckets.get(key) ?? { tokens: perMinute, lastRefill: now };

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

  /** Drop idle buckets so a long-lived process does not accumulate keys forever. */
  prune(idleMs = 300_000): void {
    const cutoff = this.#now() - idleMs;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lastRefill < cutoff) this.#buckets.delete(key);
    }
  }
}
