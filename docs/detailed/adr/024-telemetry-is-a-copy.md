# ADR-024: telemetry is a copy, never the log

**Status:** accepted · **Extends** [ADR-020](020-the-log-is-objects.md), which made the audit log
objects in a blob store.

## Decision

A target may declare extra audit sinks — `stdout`, and `otlp` to any OpenTelemetry collector. They
are **copies**. The durable log stays where ADR-020 put it: objects in the blob store, written and
awaited on the invocation path.

```yaml
targets:
  cloud:
    audit:
      sinks:
        - { kind: stdout }
        - { kind: otlp, endpoint: https://collector.example/v1/logs, headers_ref: cloud/otlp_headers }
```

## Why ordering is fixed in code rather than declared

The guarantee is one awaited event per invocation, written in a `finally`. A network sink cannot
carry it: a collector that is down would fail the write, and a write that fails on the invocation
path either fails the capability call or silently is not a guarantee.

So `openAudit` decides which sink is the log, and config only adds copies. "Which one is
authoritative" is not a preference — making it configurable would let an operator turn the
guarantee off by editing a list, without anything saying so.

The fan-out awaits the primary and hands copies to a bounded queue. Bounded because the failure it
exists for is precisely a collector that stopped answering while the gateway kept serving: an
unbounded queue turns that into memory growth and then a crash, which would take the durable log
with it. A copy is not worth the thing it is a copy of.

## Why `fetch` and not the OpenTelemetry SDK

`@opentelemetry/*` brings a provider, a processor, an exporter and resource detection to solve
batching and context propagation. Neither applies: there is one record type, it is complete when it
arrives, and there is no span to correlate it with. What is left is building one JSON object, which
is forty lines.

`bunfig.toml` enforces a seven-day release-age floor on dependencies because this repository holds
live OAuth refresh tokens. A transitive tree is a real cost against that, and this one would buy
nothing the record does not already have.

JSON rather than protobuf for the same reason — protobuf *is* the dependency. Every collector
accepting OTLP/HTTP accepts `application/json`; the spec requires it.

## Consequences

- **`Runtime.audit` is an `AuditReader`.** `tail` and `verify` mean the durable log, never the
  fan-out, and the types say so: dispatch is handed an `AuditSink` and cannot read at all.
- **A failing sink is reported once per run**, not once per event. A log line per audit event makes
  an outage louder than the traffic it is failing to copy.
- **`stdout` is the cheap durable copy on Cloud Run**, where the platform ships it to Cloud Logging
  with no configuration and no per-call bucket write. It is a copy because the platform's shipper
  buffers: an event written there has been handed over rather than stored.
- **No chain on the network sinks.** A hash chain over interleaved instances means nothing, and a
  chain nobody can re-read cannot be verified. `run` and `seq` still travel, so a gap is visible.
- **OTLP headers come from the credential store**, not the config file. They carry an API key, and
  `profile/secret-detection.ts` would refuse one written inline — correctly.
