# ADR-020: the audit log is objects, and it is hash-chained

**Status:** accepted · **Supersedes** [ADR-013](013-one-cloud-host.md)'s *"Why audit stays in the
database"*, which considered file-backed audit and rejected it.

## Decision

The audit log leaves `Database` and becomes its own store: **one object per event**, at
`audit.log/YYYY/MM/DD/<stamp>-<id>.json`, under whatever `BlobStore` the target already opened.
Locally that is a directory beneath the profile; deployed it is a prefix in the bucket. **The same
layout, the same code, on both.**

Each record carries `run`, `seq`, and `prev` — the SHA-256 of the bytes of the previous record of
the same run — and `lanes link audit verify` walks every chain.

## Why the earlier reasoning does not hold

ADR-013 rejected this, and the argument was:

> The append-only guarantee is enforced by `AuditStore` exposing no `update` and no `delete` — by
> the type system, not by convention. A log file cannot enforce that at all; anything that can open
> the file can rewrite it.

The first sentence is still true and still how the guarantee works. The second is true of **one
mutable file** and false of **a set of immutable objects**, which is what this is. A bucket
retention policy or a per-object hold makes each event unwritable by anything, enforced by the
platform. That is strictly more than the database ever offered: nothing prevented
`UPDATE audit_events` there either, and the row-level equivalent of a retention policy does not
exist in SQLite at all.

The hash chain closes the rest of the gap, and is worth having regardless of the storage. It is
also something the database version could have had and did not.

ADR-013's other two reasons were "one store to configure, one thing to back up" and "audit rows in
the same transaction domain as the state they describe". The first inverted once the log was the
only thing keeping a database in the deployed target at all. The second was never used: no code
path ever wrote an audit row and a state row in one transaction, and `dispatch` explicitly does not.

## What the chain proves, and what it does not

- A `seq` gap or a `prev` mismatch proves a record was **altered, or removed from the middle of a
  run**.
- `close()` writes a marker naming the run's final count, so **truncating a cleanly-stopped run** is
  caught. A killed process leaves a run that verifies as open — honest, not reassuring.
- **Deleting a whole run nobody knew about** is undetectable. Runs are not enumerated anywhere else,
  and a registry to hold them would move the same problem up one level.

The chain is per run rather than per log because there is no file to be ordered by, several
instances write concurrently, and a single global chain would need a lock across all of them —
which is the database this change removes.

## Consequences

- `Database` loses `audit`, and with it the last thing in it that was not rebuildable. Everything
  left can be reconstructed by reconcile from the config and the credential store; a log cannot be
  reconstructed from anything, which is why it did not belong there.
- `AuditSink` and `AuditReader` split, because a sink that ships events to stdout or to a collector
  can write and cannot be read back. Dispatch takes the **sink**, so that path structurally cannot
  read the log.
- Ordering needs `seq`. Keys are timestamped to the millisecond and then disambiguated by a random
  id, so key order is not event order — the job SQLite's implicit `rowid` and Postgres's `seq`
  column were doing. A refusal is answered without touching a provider, so same-millisecond events
  are routine rather than a corner case.
- `tail` walks days newest-first within a bounded window of years; `verify` enumerates everything,
  because a verification that skipped part of the log would report `ok` for a range it never read.
- The log costs more space than an appended file would — an event is a few hundred bytes against a
  four-kilobyte block. Retention is the answer when that matters, it stays outside the interface as
  `#audit` requires, and deployed it is a bucket lifecycle rule rather than any code.
- The log root is `audit.log`, with a dot. A provider is namespaced to `<provider>/<connection>`
  under the same blob root and a provider id is `[a-z][a-z0-9_]*`, so a name carrying a dot is one
  no provider can be scoped into. Without that, a provider called `audit` would be handed a store
  rooted inside the log — a hole in [ADR-007](007-control-plane-exclusions.md)'s wall rather than an
  untidy filename.
