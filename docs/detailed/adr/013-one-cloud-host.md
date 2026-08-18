# ADR-013: one cloud host, and adapters named for the protocol

**Status:** accepted, two sections superseded · **Supersedes** the deferral in
[ADR-004](004-declarative-config.md)'s target table, which recorded `BlobStore` as having no cloud
adapter · *"Why audit stays in the database"* below is **superseded by
[ADR-020](020-the-log-is-objects.md)**, and the `Database` row of the table above by
[ADR-021](021-no-database.md); the rest stands.

## Decision

| Interface | `local` | `cloud` |
|---|---|---|
| CredentialStore | encrypted file | `gcp-secret-manager` |
| BlobStore | filesystem | `s3` |

**Supabase is the documented cloud host**, supplying both the Postgres and the bucket. **The adapters
are named for the protocol, not the vendor.**

## Why one host

The deployed target needs two stateful things. Sourcing them from one project is one account, one
place to look when something is down, and one thing to rotate. A managed Postgres from one vendor and
object storage from another is a second bill and a second failure mode bought for nothing — the
adapters cannot tell the difference and neither can an operator.

Supabase specifically because its free tier is the cheaper answer for single-user use, and because a
gateway serving a handful of agent calls a day should not pay for a database that is idle 99% of the
time. The tradeoff is stated in `docs/detailed/deployment-cloudrun.md` rather than hidden: the free tier pauses
a project after about a week idle, and the first call after a quiet fortnight fails rather than being
slow.

## Why the adapters are not called `supabase`

This is [ADR-008](008-connectors.md)'s rule — *protocol code, not vendor code* — applied below the
connector layer. `postgres` needs a connection string; `s3` needs an endpoint and a key pair. Cloud
SQL, Neon, R2, MinIO, and AWS differ only in those values, so a vendor name on the module would claim
a coupling that does not exist and would have to be either lied about or duplicated the first time
someone pointed it elsewhere.

The host is a deploy-time choice. The protocol is the interface.

## Why blobs stopped being deferrable

`packages/storage/src/index.ts` said not to add a cloud adapter until a provider actually wrote bytes.
[ADR-012](012-owner-layer-primitives.md)'s `memory` provider writes entry bodies as blobs, so the
condition was met.

It is worth being precise about what that changed, because it is not "a feature is missing".
`adapter: filesystem` on Cloud Run **appears to work**: every write succeeds, every read within the
life of an instance succeeds, and the bytes are gone when the instance recycles. Nothing errors,
because from the container's point of view nothing is wrong. A missing adapter that throws is a
smaller problem than a present adapter that silently loses data, and the deferral had quietly turned
into the second.

## Why audit stays in the database

**Superseded by [ADR-020](020-the-log-is-objects.md).** The log is objects now. The reasoning below
is kept because the argument it makes is still the right argument — it was answered rather than
abandoned, and ADR-020 says how.

Considered and rejected: moving the audit log to append-only files, with object storage behind it for
the deployed target.

The append-only guarantee is enforced by `AuditStore` exposing no `update` and no `delete` — by the
type system, not by convention. A log file cannot enforce that at all; anything that can open the file
can rewrite it. Keeping audit inside `Database` also keeps one store to configure, one thing to back
up, and audit rows in the same transaction domain as the state they describe.

The readable-log motivation is real and is met at the presentation layer instead: `lanes link audit tail`
renders the rows. Storage format and display format are not the same decision.

## Consequences

- `storageTargetSchema` gains `endpoint`, `region`, `prefix`, `access_key_id_ref`, and
  `secret_access_key_ref`. Two credential refs rather than one, because `CredentialStore` holds
  strings and a key pair is two of them — packing both into one value would mean encoding a secret
  that routinely contains `/` and `+`.
- `openStorage` becomes async and takes a `CredentialStore`, matching `openDatabase`. A blob store
  that resolves credentials cannot be built synchronously.
- `packages/storage/src/conformance.ts` holds filesystem, S3, and the in-memory store to one
  contract, the way `packages/database/src/conformance.ts` does for the three databases. Containment
  is part of that contract: a key one target refuses must not be a key another accepts.
