import { describe, expect, test } from 'bun:test';
import { mapWithLimit, withinTime } from './pool.ts';

/**
 * The two bounds `doctor` runs its probes under.
 *
 * Both existed for the credential probe and neither reached the capability
 * probe, which is why `doctor` against a workspace with real connections
 * printed nothing for ten minutes: one provider at a time, and no clock on any
 * of them. These are small enough to be obvious and were not covered at all.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('withinTime', () => {
  test('returns what the work returned when it beats the budget', async () => {
    expect(await withinTime(1_000, 'gave up', async () => 'answered')).toBe('answered');
  });

  test('returns the fallback when the work does not', async () => {
    // The case this exists for: a vendor that accepts the connection and never
    // answers. `probe.run()` had no clock on it, so the `catch` around it —
    // which can skip a provider that *fails* — had nothing to say about one
    // that simply never returns.
    const started = Date.now();

    expect(
      await withinTime(25, 'gave up', async () => {
        await sleep(10_000);
        return 'answered';
      }),
    ).toBe('gave up');

    // Bounded by the budget rather than by the work, which is the whole claim.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a rejection is not swallowed into the fallback', async () => {
    // Giving up and failing are different answers, and the caller decides what
    // each one means. `reportCapabilityDrift` maps both to "could not ask", but
    // it does that itself rather than having it done underneath it.
    await expect(
      withinTime(1_000, 'gave up', async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
  });

  test('does not keep the process alive after the work settles', async () => {
    // The timer is cleared on the winning path. Without that a command that
    // finished every probe in a second still waits out the longest budget it
    // started, which reads from outside as exactly the hang this is fixing.
    const started = Date.now();
    await withinTime(30_000, null, async () => 'done');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('mapWithLimit', () => {
  test('keeps results in the order of the items, not of completion', async () => {
    // `reportCapabilityDrift` reads the results back positionally, and reports
    // in registry order so two runs against one workspace read the same way.
    const out = await mapWithLimit([30, 1, 15], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });

    expect(out).toEqual([30, 1, 15]);
  });

  test('never runs more than the ceiling at once', async () => {
    let running = 0;
    let peak = 0;

    await mapWithLimit(Array.from({ length: 12 }, (_, index) => index), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
    });

    expect(peak).toBe(4);
  });

  test('is a pool rather than chunks, so one slow item holds up only its slot', async () => {
    // The distinction the doc comment claims. Chunking would make every batch
    // wait for its slowest member; a pool lets the free worker keep going.
    const finished: number[] = [];

    await mapWithLimit([200, 1, 2, 3], 2, async (ms) => {
      await sleep(ms);
      finished.push(ms);
    });

    // The three quick ones all land before the slow one, which cannot happen
    // if the first two are a batch that has to drain.
    expect(finished).toEqual([1, 2, 3, 200]);
  });

  test('runs nothing, and returns nothing, for no items', async () => {
    let calls = 0;
    expect(await mapWithLimit([], 4, async () => (calls += 1))).toEqual([]);
    expect(calls).toBe(0);
  });
});
