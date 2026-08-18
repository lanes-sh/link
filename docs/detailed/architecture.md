# Architecture

Lanes Link is a self-hosted MCP endpoint that exposes a person's accounts, knowledge, procedures, and
secrets to any agent, behind an authorization boundary the runtime enforces.

The bet: `gmail.search = allow` and `gmail.send = deny` are decisions the runtime **enforces**, not
instructions the model is asked to respect. Everything below exists to make that answer binding.

## The four component types

| Type | Backed by | MCP shape | Control plane |
|---|---|---|---|
| **Connections** | a third-party vendor | tools | `lanes link connect` |
| **Memory** | `BlobStore` — one Markdown file per entry | resources + search | `lanes link memory` |
| **Skills** | `BlobStore` — one Markdown file per skill | prompts, plus `skills.manage.*` | `lanes link skills` |
| **Vault** | one encrypted document, its own key | tools, tightly scoped | `lanes link vault` |

All four are **providers** behind the same policy layer, audit log, profile boundary, and endpoint.
`memory.search = allow` is evaluated by the identical code path as `gmail.search`. The core cannot
tell them apart and must not try.

Two families, structurally identical to the core:

- **Account providers** (`gmail`, `notion`) — external, credentialed, tool-shaped
- **Owner providers** (`memory`, `skills`, `vault`, `example`) — local, owner-authored, no external
  credential, resource- and prompt-shaped

`example` is an owner provider in miniature, which is why it earns its place beyond being an SDK
sample: it proves that shape before the owner layer exists.

## Domain model

- **Profile** — a named grouping. **One profile = one config = one database = one credential
  store.** Profiles share an endpoint and its token
  ([ADR-009](adr/009-one-endpoint-per-workspace.md)); each call names the profile it acts within.
  Profiles never share a database, a credential store, or a URL. An operator wanting several
  available to one agent runs several endpoints, which costs nothing and keeps a compromise of one
  from reaching another.
- **Provider** — a *type* of capability source.
- **Connection** — one configured *instance* of a provider. `gmail.main`, `memory.work`.
  (Widened from init.md's "one configured account" so owner providers fit the same noun.)
- **Capability** — a tool, resource, or prompt a provider exposes. Addressed `provider.name`.
- **Policy** — one block per profile. Default deny.
- **AuditEvent** — append-only, generic across providers, redacted per provider.

## Layout

One package, one `src/`, thirteen components named for the question each answers.
Cross-component imports go through the package.json `imports` map — `#policy`,
`#stores/state`, `#providers/google/gmail`.

```
src/cli/           lanes link — the control plane
src/server/        Bun.serve, bearer auth, and the MCP surface it wraps
src/profile/       what a profile is: schema, loading, workspace resolution, layout
src/registry/      what exists and what it is called: providers, capabilities, reconcile
src/dispatch/      how one call runs: context, then policy → limits → provider → audit
src/policy/        rule evaluation, floor composition, rate limits
src/audit/         event shape, the sink and reader contracts, the chain, redaction rules
src/auth/          endpoint identity: token → principal
src/stores/        the BlobStore contract and the runtime state built on it
                   (state and the log are both objects in it — ADR-020)
src/secrets/       one encrypted-document format, two stores: system and vault
src/connectivity/  what a provider declares — transports/, auth/, and mail/
src/providers/     every provider, one folder each, holding all its vendor knowledge
src/deployments/   where this runs: protocol-named adapters, vendor-named deployments
```

Dependencies run one way: storage contracts → connectivity → registry/dispatch →
server/cli, with `deployments` reached only by `profile`. Nothing above imports a
backend directly.

**That direction is asserted by `src/architecture.test.ts`**, along with two other
rules the layout is meant to express: no vendor name in the code a request passes
through, and a file-size budget with an explicit list of what is still over it.
Thirteen `package.json` files used to enforce the first of those structurally;
one package does not, so the test does — at file granularity, which is stricter
than the package graph was.

**No component depends on a client library for its backend.** `Bun.S3Client` is a built-in, so
`s3.ts` reaches its store without adding a dependency to a repository that holds live refresh
tokens; Secret Manager, GCS, and the OTLP sink are `fetch` against REST APIs for the same reason.
The cost is that those adapters, along with `src/server/index.ts` and the CLI, are where
Bun-specific API use is concentrated — a port to Node would rewrite them and little else.

**There is no database.** `bun:sqlite` and `Bun.SQL` used to head that list. Every access was a
point read, a point write, or one prefix listing, so the tables were carrying a query engine
nothing queried — state is now one object per key and the audit log one object per event, both in
the `BlobStore` the target already opens (ADR-020, ADR-021). Deployed, the standing dependencies
are one bucket and Secret Manager.

## The dispatch path

Every invocation runs this sequence, with no way around it:

```
Bun.serve
  → auth              bearer token → principal, constant-time compare. Unknown → 401.
  → discovery         server built as a pure function of resolved policy, memoised
  → policy            (principal, capability, connection). Default deny, tighten-only.
  → limits            per-profile and per-connection token buckets
  → dispatch          provider receives a ProviderContext, never a raw backend
  → audit             one event, on every path, including denials
```

The ordering is not stylistic. **Policy is evaluated before a provider is reached**, so a provider
never sees a request it was not authorised to serve, and authorization is never something provider
code could get wrong. A test asserts the handler is not called on a denial.

**Exactly one audit event per invocation**, enforced by `finally` rather than by remembering to call
it at each return. See `docs/detailed/security.md` for the one documented exception.

## Policy

Default deny: an empty policy grants nothing. Composition is **tighten-only** — the optional instance
floor is evaluated first and its denial is final, so no arrangement of profile rules can widen past
it. The floor is empty in M1; the invariant is implemented anyway, because it is what makes delegated
access safe to add later and it cannot be retrofitted once rules exist in the wild.

**A deny beats an allow regardless of order in the file.** Rule ordering cannot change the answer, so
a denial is never something you can accidentally out-rank.

Wildcards are a trailing `.*` on `capability` only. Connections are never wildcarded. There is
deliberately no policy expression language: every additional operator is another way for an operator
to believe they wrote something narrower than they did.

## Discovery filtering

A capability the principal cannot reach on any connection **is not registered at all** — not
registered and refused on call. The `connection` argument's enum is built from resolved policy, so a
client cannot discover a connection it has no grant for.

Discovery filtering and invocation enforcement share one implementation (`allowedConnections`, which
calls the same `evaluate` the dispatcher uses). Computing them separately would let them drift, and a
leak in discovery is still a leak.

Under `2026-07-28` this covers **`server/discover`** as well as `tools/list` — it is a second
discovery surface, and a filter applied to only one of them is not a filter.

## Isolation

| Boundary | Mechanism |
|---|---|
| Provider ↔ provider state | `ScopedStore` namespaced `<provider>/<connection>` |
| Connection ↔ connection state | same namespace |
| Connection ↔ credentials | `ScopedCredentials` over an explicit allowlist |
| Provider ↔ blobs | `scopeBlobStore`, with traversal rejected rather than rewritten |
| Profile ↔ profile | separate database, credential store, port, and token |

Every one is enforced in the wrapper rather than trusted to the provider. An out-of-scope credential
ref fails identically to a missing one, so the error cannot enumerate the store.

## Configuration and reconcile

The config file says what exists; the credential store holds values; the database holds only runtime
state. Reconcile on boot upserts declared entities, marks undeclared connections **disabled rather
than deleted** (preserving audit history), marks a connection with a missing credential
`unauthorized` **without blocking startup**, and reports drift in both directions.

`lanes link plan` and `lanes link start` compute the same plan through the same function, so the preview cannot
become a lie.

See [ADR-004](adr/004-declarative-config.md).

## The owner layer

The capability namespaces `memory.*`, `skills.*`, and `vault.*` are **still refused at registration**
— only the built-in registry opts in, because reclaiming a namespace once providers exist in the wild
would silently change what a policy rule means.

Everything else that was reserved for it is now in use. The MCP prompts primitive carries `skills`.
`BlobStore` has its first consumer in `memory`, which is the workload the interface was defined for
before any provider existed. The resource primitive finally has a runtime path at all: it was
declared in M1 and unreachable until the owner layer needed it, which is recorded in
[ADR-012](adr/012-owner-layer-primitives.md) rather than quietly fixed.
