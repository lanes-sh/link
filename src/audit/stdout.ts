import { newRunId, type AuditDraft, type AuditEvent, type AuditSink } from './index.ts';

/**
 * The log as structured lines on stdout.
 *
 * On Cloud Run this is the cheapest durable copy available: the platform ships
 * stdout to Cloud Logging with no configuration, no bucket write per call, and
 * no dependency to declare. `container.ts` already writes its startup lines
 * there for the same reason.
 *
 * Opt-in, and never the primary. The platform's shipper buffers, so an event
 * written here has been *handed over* rather than stored — which is exactly the
 * property the primary sink must not have. Configure it alongside the blob
 * sink, or make it primary deliberately if you would rather trade the guarantee
 * for the bucket write on every call.
 *
 * One JSON object per line, `kind: "audit"`, so a log filter can separate these
 * from the plain startup lines beside them without matching on message text.
 */

export interface StdoutAuditOptions {
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  readonly run?: string;
}

export function createStdoutAuditSink(options: StdoutAuditOptions = {}): AuditSink {
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? ((): Date => new Date());
  const run = options.run ?? newRunId();
  let seq = 0;

  return {
    async append(draft: AuditDraft): Promise<AuditEvent> {
      const event: AuditEvent = { ...draft, id: `evt_${crypto.randomUUID()}`, timestamp: now() };

      // `run` and `seq` but no `prev`: a hash chain over interleaved instances
      // means nothing, and a chain nobody can re-read cannot be verified
      // anyway. The pair still makes a gap visible, which is the part of the
      // guarantee that survives a log this does not own.
      write(
        `${JSON.stringify({
          kind: 'audit',
          run,
          seq: seq++,
          ...event,
          timestamp: event.timestamp.toISOString(),
        })}\n`,
      );

      return event;
    },

    async close(): Promise<void> {
      // Nothing to close. There is no marker either: a marker exists so
      // `verify` can tell a finished run from a truncated one, and nothing
      // here can be verified.
    },
  };
}
