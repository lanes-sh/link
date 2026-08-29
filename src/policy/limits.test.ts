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

/**
 * The bound on the map itself.
 *
 * A key here is not always one the endpoint chose: at the HTTP edge a caller is
 * identified by the first `X-Forwarded-For` hop, which on a public deployment is
 * a header a stranger writes. Without a cap that is an unbounded allocation
 * driven from outside the process.
 */
describe('the key map', () => {
  test('holds no more keys than its cap, however many distinct callers arrive', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now, 100);

    for (let i = 0; i < 5_000; i++) {
      time.advance(1);
      limiter.take(`caller-${i}`, 30);
    }

    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  test('an idle caller goes before a live one', () => {
    const time = clock();
    const limiter = new RateLimiter(time.now, 10);

    // Nine callers that arrive and stop.
    for (let i = 0; i < 9; i++) limiter.take(`idle-${i}`, 30);

    // Long past the idle window for those nine. `busy` arrives now and spends
    // twice, so it is the one caller whose bucket is both live and not full.
    time.advance(400_000);
    limiter.take('busy', 30);
    limiter.take('busy', 30);

    // The insert that overflows: the nine idle buckets are dropped, and nothing
    // live is touched.
    limiter.take('newcomer', 30);
    expect(limiter.size).toBeLessThanOrEqual(10);

    // Two of thirty spent. Had `busy` been evicted, re-creating it would hand
    // back a full bucket and this would read thirty — so the number is the
    // assertion that its spend survived the eviction going on around it.
    let remaining = 0;
    while (limiter.take('busy', 30).allowed) remaining += 1;
    expect(remaining).toBe(28);
  });

  test('eviction is amortised rather than one key per overflow', () => {
    // A single eviction per insert would run a sort on every request once the
    // map is full, which turns the bound into its own denial of service. A batch
    // means most inserts past the cap do no sorting at all.
    const time = clock();
    const limiter = new RateLimiter(time.now, 100);

    for (let i = 0; i < 100; i++) {
      time.advance(1);
      limiter.take(`caller-${i}`, 30);
    }
    expect(limiter.size).toBe(100);

    // The insert that overflows drops a tenth, so there is room for nine more
    // before the next one has to.
    time.advance(1);
    limiter.take('overflows', 30);
    expect(limiter.size).toBe(91);
  });
});
