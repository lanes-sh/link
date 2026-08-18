import type { AuditDraft, AuditEvent, AuditSink } from './index.ts';

/**
 * One record of truth, and any number of copies.
 *
 * The guarantee is one awaited event per invocation, written in a `finally`
 * (`#dispatch`). A network sink cannot carry that: it fails when a collector is
 * down, it adds its latency to every capability call, and making the log a
 * precondition for answering would mean an observability outage takes the
 * gateway with it.
 *
 * So the first sink is awaited and everything after it is best-effort behind a
 * bounded queue. That ordering is not configuration-shaped politeness — it is
 * the difference between a sink and *the* log, and `openAudit` is the only
 * place that decides which is which.
 */

/**
 * How many events may be waiting on a secondary sink before they are dropped.
 *
 * Bounded because the alternative is worse in exactly the case that matters: a
 * collector that has stopped answering while a gateway keeps serving. An
 * unbounded queue turns that into memory growth and then a crash, taking the
 * durable log with it — a copy is not worth the thing it is a copy of.
 */
const MAX_QUEUED = 1000;

export interface FanOutOptions {
  /** Written and awaited. This one is the log. */
  readonly primary: AuditSink;
  /** Copies. Failures are reported once and never raised to the caller. */
  readonly secondaries: readonly AuditSink[];
  /** Where a dropped or failed copy is mentioned. Once per sink, not per event. */
  readonly onError?: (message: string) => void;
}

export function fanOutAudit(options: FanOutOptions): AuditSink {
  const { primary, secondaries } = options;
  if (secondaries.length === 0) return primary;

  const report = options.onError ?? ((): void => {});
  let queued = 0;
  let dropped = 0;
  let complained = false;

  const copy = (event: AuditEvent): void => {
    if (queued >= MAX_QUEUED) {
      dropped += 1;
      if (!complained) {
        complained = true;
        report(`audit fan-out is behind; dropping copies (the primary log is unaffected)`);
      }
      return;
    }

    queued += 1;
    void Promise.allSettled(
      // `append` on a secondary re-stamps an id and a timestamp it will not
      // use — the event is already written. Passing the draft keeps the sink
      // interface single, and the cost is one uuid nobody reads.
      secondaries.map((sink) => sink.append(event)),
    )
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected' && !complained) {
            complained = true;
            report(`audit fan-out failed: ${String(result.reason)}`);
          }
        }
      })
      .finally(() => {
        queued -= 1;
      });
  };

  return {
    async append(draft: AuditDraft): Promise<AuditEvent> {
      const event = await primary.append(draft);
      copy(event);
      return event;
    },

    async close(): Promise<void> {
      // Give the queue a moment to drain rather than waiting on it: a
      // collector that is down must not hold a shutdown open, and Cloud Run
      // gives a bounded grace period before it stops caring.
      const deadline = Date.now() + 2000;
      while (queued > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (dropped > 0) report(`audit fan-out dropped ${dropped} copies this run`);
      await Promise.allSettled(secondaries.map((sink) => sink.close()));
      await primary.close();
    },
  };
}
