/**
 * Running a bounded number of slow things at once, and giving up on one.
 *
 * Both halves were written inside `connection-probe.ts` for the credential
 * probe, and both were missing from the other probe `doctor` runs. That is the
 * whole of issue #173: `reportCapabilityDrift` walked its providers one at a
 * time with no ceiling on how long any of them could take, so a single vendor
 * that accepted a connection and never answered stalled the command for as
 * long as an operator was willing to wait.
 *
 * Shared rather than copied, for the reason `secretGrantSteps` is shared: a
 * second spelling of a timeout is not a wrong answer on screen, it is a bound
 * that exists on one path and not on the other.
 */

/**
 * `Promise.all` with a ceiling, in the ten lines it takes.
 *
 * A pool rather than chunks: chunking would make every batch wait for its
 * slowest member, which is the shape this is trying to avoid.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The work, or `fallback` once `ms` has passed.
 *
 * **This races rather than cancels**, and the difference is worth stating
 * because it decides what the bound is actually worth. Neither `refreshDirectly`
 * nor the MCP transport takes an `AbortSignal` — a grep for one across the
 * transport returns nothing — so the request that lost the race is still in
 * flight, finishing into a handler nobody is waiting on. What is bounded is how
 * long the *caller* waits, which for a read-shaped command is the thing an
 * operator is actually stuck on.
 *
 * It is a real bound even so: the promise is abandoned, not awaited again, and
 * the timer is cleared on the winning path so nothing holds the process open
 * after the work settles. Threading a signal through two transports to turn
 * this into a cancellation is a larger change, and it would not make `doctor`
 * finish any sooner.
 */
export async function withinTime<T>(ms: number, fallback: T, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
