# ADR-021: there is no database

**Status:** accepted · **Supersedes** [ADR-013](013-one-cloud-host.md)'s `Database` row and
[ADR-004](004-declarative-config.md)'s "No ORM" note, which chose `bun:sqlite` over an ORM for a
schema this record removes · **Follows** [ADR-020](020-the-log-is-objects.md), which took the log
out first.

## Decision

`Database`, `sqlite.ts`, and `postgres.ts` are deleted. Runtime state — connection status, provider
state, sync cursors — is **one object per key** in the `BlobStore` the target already opened, at
`state.kv/<namespace>/<key>.json`. The `database:` target block is gone; a profile that still
carries one loads unchanged, because zod strips keys the schema does not name.

## Why

Four tables, and **every query was a point read, a point write, or one prefix listing**. No joins,
no aggregates, no ordering that mattered, no search. The one workload with a real query shape was
the audit log's `tail`, and ADR-020 moved that out. What was left was a key-value store paying for
a query engine, a migration mechanism, a connection pool, and — in the deployed target — a whole
second service, none of which anything used.

Keeping Postgres as an opt-in adapter was considered and rejected. An adapter nothing exercises by
default is one that rots: the conformance suite existed precisely because two implementations of
one contract will drift, and the cost of that suite is only worth paying while both are real.

## Consequences

- **The deployed target loses a dependency.** Not a smaller one — an entire managed service, with
  its own bill, its own credential, and its own failure mode. What ADR-013 called "one cloud host
  supplies both stateful things" is now one bucket.
- **`migrate()` is gone**, and with it the schema version, the downgrade guard, and the Postgres
  advisory lock that existed because every Cloud Run instance migrated on boot. There is no schema
  to version.
- **Local and deployed run the same code.** The only difference is which `BlobStore` opened, so
  there is no longer a class of bug that appears in one target and not the other.
- **`RuntimeState.kv`, not `.state`.** A member called `state` on a type called `RuntimeState` reads
  as the whole rather than the part, which is what it was doing while the type was called
  `Database`.
- **Keys are percent-encoded per segment.** Keys come from providers and are arbitrary strings; `.`
  and `/` both have to be escaped, and `..` in particular is a traversal that `encodeURIComponent`
  would pass through untouched. The cost is that the reserved namespaces read as
  `connections%2Ev1` in a listing. That is ugly and it is correct, and the alternative — exempting
  `.` to make it pretty — buys nothing except a rule with an exception in it.
- **The conformance suite is gone**, replaced by tests over two blob stores. Three implementations
  of one contract needed a suite; one implementation over interchangeable backings needs the
  backings held to *their* contract, which `#stores/blobs/conformance.ts` already does.
- **Nothing is lost that was not rebuildable.** Reconcile restores the connection rows from the
  config file, a discovery cache re-discovers, and a logged-out connector authorises again. That
  was already the stated contract of this store; it is now the only thing in it.
