import type { AuditDraft, AuditEvent, AuditSink } from '#audit';
import type { FetchLike } from './gcs.ts';

/**
 * The log to an OpenTelemetry collector, over OTLP/HTTP with a JSON body.
 *
 * `fetch` and a shape, rather than `@opentelemetry/*`. The SDK brings a
 * provider, a processor, an exporter and a resource detector to solve batching
 * and context propagation — neither of which applies here: there is one record
 * type, it is already complete when it arrives, and there is no span to
 * correlate it with. A repository that enforces a seven-day release-age floor
 * on dependencies because it holds live refresh tokens does not add a
 * transitive tree to build one JSON object.
 *
 * JSON rather than protobuf for the same reason — protobuf would be the whole
 * of the dependency. Every collector that accepts OTLP/HTTP accepts
 * `application/json`; the spec requires it.
 *
 * **Never the primary sink.** This is a copy, and `fanOutAudit` is what keeps
 * that true: a collector being down must not fail a capability call, and the
 * durable log is somewhere that does not need a network.
 */

/** OTel severity numbers. The spec's scale, not an invention. */
const SEVERITY_INFO = 9;
const SEVERITY_WARN = 13;
const SEVERITY_ERROR = 17;

export interface OtlpAuditOptions {
  /** The logs endpoint, e.g. `https://collector.example/v1/logs`. */
  readonly endpoint: string;
  /** Static headers — an API key, a tenant id. Resolved from a credential ref by the caller. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly serviceName?: string;
  readonly now?: () => Date;
  readonly fetch?: FetchLike;
  /** Abandon a send after this long, so a hung collector cannot pile up copies. */
  readonly timeoutMs?: number;
}

export function createOtlpAuditSink(options: OtlpAuditOptions): AuditSink {
  const call = options.fetch ?? globalThis.fetch;
  const now = options.now ?? ((): Date => new Date());
  const serviceName = options.serviceName ?? 'lanes-link';
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    async append(draft: AuditDraft): Promise<AuditEvent> {
      const event: AuditEvent = { ...draft, id: `evt_${crypto.randomUUID()}`, timestamp: now() };

      const response = await call(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(payload(event, serviceName)),
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Raised so the fan-out can report it once. It never reaches a caller.
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`OTLP collector answered ${response.status}. ${detail}`);
      }
      return event;
    },

    async close(): Promise<void> {},
  };
}

function payload(event: AuditEvent, serviceName: string): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: [stringAttribute('service.name', serviceName)] },
        scopeLogs: [
          {
            scope: { name: 'lanes-link/audit' },
            logRecords: [logRecord(event)],
          },
        ],
      },
    ],
  };
}

function logRecord(event: AuditEvent): unknown {
  return {
    // Nanoseconds as a string: the spec's type is fixed64, and a millisecond
    // timestamp times a million is past 2^53 — JSON's number would round it.
    timeUnixNano: `${BigInt(event.timestamp.getTime()) * 1_000_000n}`,
    severityNumber: severityOf(event),
    severityText: severityTextOf(event),
    // The capability, so a collector's default view is a list of what was
    // attempted rather than a column of identical strings.
    body: { stringValue: event.capability },
    attributes: [
      stringAttribute('lanes.profile', event.profile),
      stringAttribute('lanes.principal', event.principal),
      stringAttribute('lanes.provider', event.provider),
      stringAttribute('lanes.authorization', event.authorization),
      stringAttribute('lanes.status', event.status),
      stringAttribute('lanes.event_id', event.id),
      { key: 'lanes.duration_ms', value: { intValue: String(event.durationMs) } },
      ...(event.connection ? [stringAttribute('lanes.connection', event.connection)] : []),
      ...(event.clientLabel ? [stringAttribute('lanes.client', event.clientLabel)] : []),
      ...(event.error ? [stringAttribute('lanes.error', event.error.kind)] : []),
      // Already redacted by the time it reaches any sink — a provider declares
      // what survives, and the default keeps no values at all. Serialised
      // rather than flattened into attributes because the shape is nested and
      // a collector's attribute model is not.
      stringAttribute('lanes.arguments', JSON.stringify(event.arguments)),
    ],
  };
}

function severityOf(event: AuditEvent): number {
  if (event.status === 'error') return SEVERITY_ERROR;
  return event.authorization === 'allowed' ? SEVERITY_INFO : SEVERITY_WARN;
}

function severityTextOf(event: AuditEvent): string {
  if (event.status === 'error') return 'ERROR';
  return event.authorization === 'allowed' ? 'INFO' : 'WARN';
}

function stringAttribute(key: string, value: string): unknown {
  return { key, value: { stringValue: value } };
}
