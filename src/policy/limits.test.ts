import { describe, expect, test } from 'bun:test';
import { RateLimiter } from './limits.ts';

/** A controllable clock, so nothing here sleeps. */
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('rate limiting', () => {
  test('allows up to the limit, then refuses', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    for (let i = 0; i < 5; i++) {
      expect(limiter.take('personal', 5).allowed).toBe(true);
    }
    expect(limiter.take('personal', 5).allowed).toBe(false);
  });

  test('refills continuously rather than on a window boundary', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    for (let i = 0; i < 60; i++) limiter.take('personal', 60);
    expect(limiter.take('personal', 60).allowed).toBe(false);

    time.advance(1_000); // 60/min == 1/sec
    expect(limiter.take('personal', 60).allowed).toBe(true);
    expect(limiter.take('personal', 60).allowed).toBe(false);
  });

  test('a fixed window would permit a double burst across the boundary; this does not', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    // Drain the bucket at the end of a notional minute.
    for (let i = 0; i < 10; i++) limiter.take('personal', 10);
    time.advance(60_000 - 1);

    // A fixed-window limiter resets here and would grant 10 more immediately,
    // delivering 20 calls in ~1ms. Continuous refill grants ~10 over the minute.
    let granted = 0;
    for (let i = 0; i < 20; i++) if (limiter.take('personal', 10).allowed) granted++;
    expect(granted).toBeLessThanOrEqual(10);
  });

  test('never exceeds the ceiling however long it has been idle', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    time.advance(60 * 60 * 1000); // an hour of accrual
    let granted = 0;
    for (let i = 0; i < 50; i++) if (limiter.take('personal', 10).allowed) granted++;
    expect(granted).toBe(10);
  });

  test('buckets are independent per key, so one connection cannot starve another', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    for (let i = 0; i < 5; i++) limiter.take('conn:gmail.main', 5);

    expect(limiter.take('conn:gmail.main', 5).allowed).toBe(false);
    expect(limiter.take('conn:gmail.side', 5).allowed).toBe(true);
  });

  test('reports when capacity returns', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    for (let i = 0; i < 60; i++) limiter.take('personal', 60);

    const refused = limiter.take('personal', 60);
    expect(refused.allowed).toBe(false);
    // At 60/min a token returns within a second, so the hint must be usable
    // rather than a generic "try later".
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1_000);
  });

  test('a limit of zero refuses everything', () => {
    const limiter = new RateLimiter(clock().now);
    expect(limiter.take('personal', 0).allowed).toBe(false);
  });

  test('pruning drops idle buckets without resurrecting spent capacity', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now);

    for (let i = 0; i < 5; i++) limiter.take('personal', 5);
    expect(limiter.take('personal', 5).allowed).toBe(false);

    time.advance(10_000);
    limiter.prune(300_000); // not idle long enough
    expect(limiter.take('personal', 5).allowed).toBe(false);
  });
});
