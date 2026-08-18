# Lanes Link

> **Amended after M1 Stage 1.** This document is normative and has been updated to match what was
> built. Every departure from the original text is recorded in `docs/detailed/adr/` with its reasoning; the
> significant one is [ADR-003](adr/003-auth-model.md), which replaced per-client policy with one
> token and one policy block per profile.

An open source MCP hub for everything an agent needs to act as you. Connect it once, then use it
securely from any agent. Run it locally, on your own cloud, or managed on Lanes Cloud.

Lanes Link is a self-hosted capability layer. It exposes a user's accounts, data, and custom capabilities to AI agents through a single MCP endpoint. Any compatible agent (Claude, Codex, ChatGPT, custom runtimes) is a replaceable client of the same infrastructure. The user owns the data, credentials, permissions, configuration, and deployment.

## The four component types

The endpoint is not only a route to external accounts. It serves four kinds of thing, all behind the
same policy layer, audit log, and profile boundary:

| Type | What it is | Backed by | MCP shape | Milestone |
|---|---|---|---|---|
| **Connections** | external accounts — Gmail, Notion, Linear, Drive | third-party vendor | tools | M1, M2 |
| **Memory** | the owner's persistent, accumulated knowledge | local store | resources + search | M4 |
| **Skills** | the owner's reusable procedures | local store | prompts | M4 |
| **Vault** | the owner's secret material — passwords, API keys | local encrypted store | tools, tightly scoped | M4 |

`memory.search = allow` and `vault.get = deny` are evaluated by the identical code path as
`gmail.search` and `gmail.send`. The core cannot tell these apart and must not try — hard constraint
1 below.

Two provider families, structurally identical to the core: **account providers** (external,
credentialed, tool-shaped) and **owner providers** (local, owner-authored, no external credential,
resource- and prompt-shaped).

The agent runtime lives outside this project. This project supplies the capabilities that agent runtimes consume.

CLI binary: `lanes`, whose `link` area holds every command below — `lanes link <command>`.

License: Apache-2.0. Open source from day one. No secret, credential, or personal configuration ever enters the repository.

---

## Hard constraints

1. **The core stays small.** It knows nothing about Gmail, Notion, calendars, or any domain concept. Everything domain-specific is a provider.
2. **Everything is additive.** There is no fixed personal ontology. New providers install without modifying core.
3. **Providers and connections are separate.** A provider is a type of capability source. A connection is one configured instance of that provider. Multiple connections per provider are the normal case, not an edge case.
4. **Provider-scoped tools are the default.** `gmail.search`, not a normalized `mail.search`. Cross-provider abstractions are optional modules added later, never in the core.
5. **This is not an agent runtime.** See Non-goals.
6. **Infrastructure is pluggable through interfaces.** No module imports a database, storage, or credential backend directly.
7. **Permissions are first class** and live in the core, never inside provider logic.
8. **Every tool invocation is auditable**, with provider-controlled redaction.
9. **Portability and user ownership are product properties.** A future hosted offering uses the same runtime and data model. Users can export and migrate.
10. **Control-plane decisions are not agent-reachable.** Anything that authorizes future agent behavior (policy, tokens, credentials, configuration) is CLI-only. See Deliberately excluded from MCP.

## Non-goals

Do not build: agent loops, continuous reasoning, scheduled execution, email triage, morning briefs, summarization, task planning, agent handoffs, multi-agent coordination, prompt orchestration, model routing, LLM memory algorithms, a chat interface, or a workflow scheduler.

These are consumers of this platform. Do not make any agent runtime a required dependency.

## Positioning (context, not requirements)

Three adjacent categories exist.

**MCP gateways** (Bifrost, IBM ContextForge, Lunar, MintMCP, Kong) sit in front of existing MCP servers and add auth, RBAC, and observability. They route to servers; they do not integrate accounts, and they are shaped for enterprises.

**Connector platforms** (Composio, Arcade, Pipedream, Nango) do integrate accounts, but are managed, multi-tenant, and built for developers authenticating their own customers rather than for an individual owning their own setup.

**Agent harnesses** (qm, and the coding agents generally) take the opposite architectural bet on integration: give the agent a durable sandbox, install logged-in CLIs, and let it run shell commands. This is more flexible and it is why those systems can move fast. The cost is that per-capability authorization becomes impossible. qm's own security documentation concedes its command policy is bypassable and describes it as a speed bump rather than a boundary. Once an agent holds a shell and a credential file, "allow search, deny send" is not enforceable.

**Personal agent stacks** — Garry Tan's [gstack](https://github.com/garrytan/gstack) (opinionated
Claude Code skills) and [gbrain](https://github.com/garrytan/gbrain) (the memory system behind them,
with per-repo read-write / read-only / deny trust policies). The thesis is the same one driving this
project: curated memory plus reusable skill files plus a thin harness turn rented frontier models
into owned, compounding assets.

The difference is the delivery model, and it is the same argument as the one above. gstack and gbrain
are harness-side — files on disk that one agent reads directly — which is why they move fast, and
also why gbrain's read-only is a convention rather than a boundary. Lanes Link puts the same assets
behind a gateway, so `memory.read = allow` / `memory.write = deny` is enforced by the runtime, works
for any agent rather than one harness, and is auditable per call. **The same compounding personal
assets, delivered as a policy-enforcing MCP gateway rather than as a file layout.**

Lanes Link's bet is the opposite: typed capabilities behind a policy layer, so `gmail.search = allow` and `gmail.send = deny` are real decisions the runtime enforces rather than instructions the model is asked to respect. Combined with self-hosting, single-user focus, user-owned credentials, and profile isolation, that is the gap. The individual integrations are commoditized; the enforcement boundary and the ownership are the product.

---

## Domain model

**Profile** is a named grouping of connections, usually `personal` or `work`. Connections, policy, and audit events belong to a profile.

**One profile equals one config file equals one instance equals one deployment equals one MCP endpoint.** This is a rule, not a default. Profiles never share a database, a credential store, or a URL. An operator wanting several profiles available to one agent configures several MCP servers in that agent, which costs nothing and keeps a compromise of one profile from reaching another.

Because the mapping is one to one, **profile is the CLI selector**: `--profile work` resolves to `profiles/work.yaml`. The core still attaches no behavior to particular profile names.

**ProviderDefinition** describes a provider type: `id`, `name`, `version`, capabilities, configuration schema, connection schema, authentication requirements.

**Connection** is one configured *instance* of a provider: `id`, `provider`, `display_name`, `config`, `credential_ref`, `status`, timestamps. Identity is `provider.id`, for example `gmail.main`. Connection ids are unique per provider, so `gmail.main` and `icloud_mail.main` coexist.

*(Widened from "one configured account" so owner providers fit the same noun: `memory.work` and `vault.personal` are connections in exactly the sense `gmail.main` is.)*

**Capability** is a tool, resource, or **prompt** a provider exposes (`gmail.search`, `example://note/{key}`). The provider owns the implementation. Prompts join the list because that is what skills are.

**Principal** is who is acting. In M1 there is exactly one per profile — the owner — resolved from the profile's bearer token.

**Policy** is one block per profile granting access to a capability on a connection. Default is deny. Each rule resolves to `allow`, `deny`, or (reserved, not implemented, and failing closed) `approval_required`. Rules are revocable and carry an optional `expires_at`. A deny beats an allow regardless of order in the file.

> **Amended — [ADR-003](adr/003-auth-model.md).** The original design had a `Client` entity, one
> token and one rule set per consumer. That is one more layer of indirection than the single-owner
> case needs, and the granularity it bought is available more strongly elsewhere: **a narrower grant
> is a narrower profile**, and profiles already share no database and no credential store. (Since
> [ADR-009](adr/009-one-endpoint-per-workspace.md) they do share an endpoint and its token, so the
> strongest available boundary is a second workspace.)
> `Client` is gone. Policy evaluation still takes a `principal` — one parameter — which is what keeps
> the delegation slot in the guarantee table honest.

Policy composition is **monotonically tightening**. An optional instance-level floor may deny capabilities outright. Profile rules may only narrow what the floor permits; they can never widen it. A rule may deny or require approval, never add an allow that the floor withheld. This invariant is what makes delegation safe later, so implement it in M1 even though the floor starts empty.

**AuditEvent** records timestamp, profile, principal, provider, connection, capability, argument metadata (redacted), result status, duration, authorization result, and error info. It also records the MCP `clientInfo` name as an **observability-only** label — self-reported, and never consulted for authorization. Generic across providers. Append-only.

---

## Configuration

Configuration is **declarative desired state**. The config file is the source of truth for what exists. The credential store holds credential values. The database holds only runtime state.

This matters because the deployed target is serverless and scales to zero: administering a remote instance by shelling into a container or tunnelling to its database is not workable. Declared config plus a reconcile step on boot removes that problem, and makes the whole setup diffable and reproducible.

**The CLI's mutating commands edit this file; they do not write to the database.** Declarative config and an imperative CLI are not opposites. `lanes link connect`, `lanes link policy allow`, and `lanes link token rotate` are conveniences that produce a correct config file, so the operator never has to hand-edit YAML while the file remains the single source of truth. Implement config writes with a comment-preserving YAML document API, since an operator's comments and ordering must survive a CLI edit.

**Config flows one way: local CLI to remote instance.** A deployed instance never mutates its own configuration and exposes no administrative API. This extends ADR-007: the control plane sits outside the agent and outside the deployment.

### Targets

One config describes one profile and can run in more than one place. A target names an adapter set (and, for cloud, its deployment coordinates). Connections, clients, policies, providers, and limits are declared once and apply to every target.

Credentials follow the target, because each target has its own credential store. `lanes link connect gmail.side --target cloud` writes the refresh token into Secret Manager; the same command with `--target local` writes it into the local encrypted file. `lanes link secrets push --from local --to cloud` migrates a setup built locally first.

### Split of responsibilities

| Lives in config | Lives in credential store | Lives in database |
|---|---|---|
| contract version, profile, targets and adapter selection, connections, policy, provider enablement, limits, OAuth app references | OAuth client secrets, refresh tokens, app passwords, the profile bearer token | connection status, token expiry, sync cursors, audit events |

**Config never contains a credential value.** Only `_ref` pointers into the credential store.

### Example (`config/personal.example.yaml`)

```yaml
contract: 1

instance:
  profile: personal
  default_target: local

# Adapter selection is per target. Everything below targets is
# target-independent and declared exactly once.
targets:
  local:
    database:    { adapter: sqlite, path: ./data/personal.db }
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/personal/files }
  cloud:
    database:    { adapter: postgres, url_ref: cloud/database_url }
    credentials: { adapter: gcp-secret-manager, project: lanes-link-demo }
    storage:
      adapter: s3
      bucket: lanes-link-demo-files
      endpoint: https://abcdefgh.storage.supabase.co/storage/v1/s3
      access_key_id_ref: cloud/s3_access_key_id
      secret_access_key_ref: cloud/s3_secret_access_key
    deploy:
      platform: cloudrun
      project: lanes-link-demo
      region: europe-west1
      service: lanes-link-demo
      access: iam

limits:
  requests_per_minute: 120        # per profile
  upstream_calls_per_minute: 60   # per connection, protects vendor quota

# App registrations. Shared by every connection of that vendor.
oauth_apps:
  google:
    client_id_ref: google/client_id
    client_secret_ref: google/client_secret

# One entry per authorised account. "account" is the identity the provider
# reports, resolved at connect time, and the id derives from it — so this list
# answers "whose mailbox is this" without a lookup. Where the credential lives
# is the provider manifest's answer rather than this file's; an optional
# "credential_ref" here adds a secret the connection may reach and does not
# move the one it authenticates with.
#
# There is no "providers" block: declaring a connection is what enables a
# provider, and a second place to say so could only ever disagree.
connections:
  - id: ada_lovelace
    provider: gmail
    account: ada.lovelace@example.com
  - id: rin_shaw
    provider: gmail
    account: rin.shaw@example.com
  - id: local
    provider: example
    account: Scratch

# One token for the endpoint this profile serves — which since ADR-009 is every
# profile in the workspace. A narrower grant is a narrower profile, not a
# narrower client (ADR-003); a boundary that must hold against the agent itself
# is a second workspace.
auth:
  mode: bearer
  token_ref: profile/token

# Default deny. Only listed rules grant access, and an absent policy block
# grants nothing at all.
policy:
  allow: ['*']
  deny:  [gmail.users.drafts.send]
```

Rules name capabilities, never connections: `gmail.*` covers every Gmail account in the profile.
Three forms — `*`, `gmail.*`, `gmail.users.drafts.send` — and a trailing `.*` at any depth is the
only wildcard. Do not build a policy expression language.

### Validation rules

These are enforced by the loader and covered by tests, not merely documented.

1. **Unknown contract major fails closed.** A config declaring a contract major the binary does not implement is rejected outright. Never attempt a best-effort load.
2. **Secret-shaped values are rejected.** Any config value matching credential patterns (private key blocks, `sk-`, `xoxb-`, `ya29.`, long high-entropy strings, keys named `*_secret`, `*_token`, `*_password`, `*_key` carrying a literal value rather than a `_ref`) causes a hard validation failure naming the offending path. This turns "config holds no credentials" from an intention into a check.
3. **Every `_ref` must be a well-formed secret-store key.** Existence is checked by `doctor`, not the loader, so an unconnected account does not block startup.
4. **Ids are unique** per provider for connections. Duplicates fail.
5. **An `allow` rule naming a provider with no connection fails.** A typo must not silently produce a rule that grants nothing. A `deny` may name one — withholding something before connecting it is reasonable.
6. **`default_target` and any `--target` must name a declared target.** A cloud target must carry complete deployment coordinates.
7. **A CLI config write validates the resulting document before writing**, and never leaves the file invalid on failure.
8. A real config file is gitignored. Only `*.example.yaml` is committed.

### Reconcile on boot

1. Validate config. Fail fast with a message naming the exact path on any error.
2. Upsert declared profiles, connections, and policies.
3. Mark undeclared connections `disabled` rather than deleting them, preserving audit history.
4. Resolve each connection's credential, at the ref its provider manifest derives. If missing, set status `unauthorized`. Do not fail startup; surface it in `lanes link doctor` and return an actionable error if a capability on that connection is called.
5. Detect drift in both directions and report it: declared items the database lacks, and database items config no longer declares.

`lanes link plan` prints exactly what reconcile would change without mutating anything. Because reconcile disables undeclared connections, this step exists so that outcome is never a surprise.

---

## Secrets and credentials

> **Amended.** The infrastructure interface is called **`SecretStore`**, not "secret store",
> because "secrets" means two different things and collapsing them is the most damaging single
> mistake available here:
>
> - **Credentials** — refresh tokens, OAuth app secrets, the profile token. These authorise *the
>   system itself* and are **never agent-reachable, in any form**. If an agent could read the Gmail
>   refresh token it would simply call Google directly, and the entire policy layer would become
>   decorative.
> - **Vault items** (M3) — the owner's own passwords and API keys, which an agent may legitimately be
>   granted access to under policy.
>
> `Vault` is a separate provider over a separate store with a **separate encryption key**, and it must
> never be implemented on top of `SecretStore`. A test asserting the boundary exists in M1,
> before the vault does.

Two distinct kinds of credential, which must not be collapsed either:

- **OAuth app credentials** (`client_id`, `client_secret`) belong to one registered application per vendor. All three Gmail connections authorize against the same Google app, and Drive and Calendar will share it later. Referenced from `oauth_apps`.
- **Connection credentials** (refresh token, app-specific password) belong to one connection. Three Gmail accounts means three refresh tokens. Their ref derives from the provider manifest and the connection id, never from a field a config file may set — the flow that writes one and the reconcile that reports on it have to agree, and deriving is what makes that free.

Credential store key layout: `google/client_secret`, `gmail/main`, `gmail/side`, `profile/token`.

**Use a separate key per purpose.** The credential-encryption key for the local encrypted-file store is distinct from the profile token, and will be distinct again from the M4 vault key. Do not reuse one master secret across purposes.

Access tokens are derived at runtime from refresh tokens and cached in memory per instance. Never persist them.

Encryption at rest protects stored credentials from direct reads of the database or file. It does not protect a credential while a process is using it. That limit is inherent, and it is stated in the security model rather than papered over.

---

## OAuth connection flow (ADR-005)

**Decision: the CLI performs the OAuth exchange using a loopback redirect. The server never participates in the OAuth dance.**

```
lanes link connect gmail.side
```

0. CLI resolves the target config, prints it, and verifies `gmail.side` is declared there.
1. CLI reads `oauth_apps.google` and resolves the client id and secret from the configured credential store.
2. CLI starts a temporary local listener on `http://127.0.0.1:<port>/callback`.
3. CLI opens the browser to Google's consent screen with that redirect URI.
4. User picks the account and consents.
5. CLI receives the authorization code, exchanges it for a refresh token, writes the token to `gmail/side` in the configured credential store, and shuts the listener down.

This works identically whether the target instance is local or on Cloud Run, because the CLI writes to whichever credential store the config names. It requires no public HTTPS callback, no domain verification, and no inbound path to the server.

**Register the Google OAuth client as a "Desktop app" type**, which permits loopback redirect URIs.

**Verify before starting, because it will silently break otherwise:** a Google Cloud project left in "Testing" publishing status expires refresh tokens after roughly a week, which would kill all Gmail connections on a schedule. Move the app to production status. Gmail read scopes are "restricted", so an unverified production app shows a warning screen on consent and is subject to a user cap; for single-owner use, accept the warning screen. If a Google Workspace domain is available, an "Internal" app avoids this entirely. Confirm current Google policy before implementing, as these rules change.

---

## MCP surface

### Transport

Stateless streamable HTTP on a single endpoint (`POST` and `GET` on `/mcp`). Do not implement SSE; it is deprecated. Stateless is mandatory: serverless replaces instances between requests, so any in-memory session state produces intermittent 404s. The current spec revision removed the session handshake, which aligns with this.

> **Amended — [ADR-002](adr/002-transport-and-statelessness.md).** Built on **MCP SDK v2**, protocol
> revision **`2026-07-28`**:
>
> ```
> @modelcontextprotocol/core@2.0.0     protocol + types   (one dependency: zod)
> @modelcontextprotocol/server@2.0.0   server runtime
> ```
>
> The original text pointed at `@modelcontextprotocol/sdk` 1.29.x. That package is the **frozen v1
> monolith** — which is why it still reads 1.30.0 and supports only up to `2025-11-25`. v2 was
> published under split package names. Two consequences beyond currency: `2026-07-28` requires the
> method (and, where the payload names one, the target) in headers as well as the body and rejects
> requests where the two disagree; and v2's `core` has one runtime dependency where v1's `sdk` had
> about seventeen, which matters for a repository holding live refresh tokens.
>
> `@modelcontextprotocol/server-legacy` is only the frozen v1 SSE transport, so it is never needed.

**`server/discover` is a second discovery surface.** Under this revision it is a mandatory RPC, and
policy filtering must cover it as well as `tools/list` — a filter applied to only one of them is not
a filter.

### Connection routing (ADR-001)

Connection identity is a tool argument, never part of the tool name.

- Tool: `gmail.search`
- Required argument: `connection`, an enum populated per client from that client's allowed connections

Rejected: dynamically namespaced tools (`gmail.main.search`, `gmail.side.search`). The target setup reaches roughly ten connections, which would produce fifty or more near-duplicate tool definitions, harming discoverability and client compatibility. One tool set per provider scales to any number of accounts.

Because the enum is built from resolved policy, a client cannot discover connections it may not use.

### Tools versus resources (ADR-006)

Do not make everything a tool. Use resources for read-oriented document or structured context; use tools for actions and parameterized queries. Decide per capability and record the reasoning in `docs/detailed/providers.md`. Verify current SDK resource patterns before implementing.

### Deliberately excluded from MCP (ADR-007)

The following are reachable through the CLI only, and must never be exposed as MCP capabilities:

- **Policy changes.** Granting or revoking any rule.
- **Token management.** Minting, rotating, or reading a token value.
- **Connection creation and credential writing**, including running the OAuth flow.
- **Configuration mutation** of any kind.
- **Reading raw secret values.**
- **Audit mutation or deletion.** The log is append-only. Audit reading is CLI-only in M1.

The unifying principle: each of these authorizes *future* agent behavior, so the decision itself must originate outside the agent. A prompt-injected or confused client that could widen its own policy would defeat the entire authorization layer in one call.

The same principle extends to the deployment. A running instance, local or remote, never mutates its own configuration and exposes no administrative API. Configuration changes originate from the operator's CLI and arrive by deployment. There is therefore no admin surface on the public URL to attack.

**These will look like capability-parity gaps when someone audits the CLI against the MCP surface. They are walls, not gaps.** Do not "complete" the parity without revisiting the reasoning here. Enforce this with a test asserting that no registered capability maps to a control-plane operation.

---

## Authentication and authorization

Deployments are single-tenant. Run one instance per profile, so personal and work never share a database or credential store. Put the work instance in a separate cloud project.

**Before routing work accounts through a self-hosted tool, confirm this is acceptable under the relevant employment and security policy.**

- **M1:** one bearer token per profile, resolved from the credential store. The token resolves to the profile's owner principal. There is no unauthenticated mode.
- **Target:** the OAuth 2.1 resource-server model the MCP spec expects, where the server validates tokens issued by an external authorization server and enforces policy internally. Keep client-identity, authentication, authorization, and connection-credential concerns behind separate interfaces so this drops in without touching providers. Do not invent cryptography.

**Upstream credential rule (mandatory).** The server never forwards a client's token to an upstream API. Each connection holds its own upstream credentials, and the server acts as its own OAuth client to Google and others. This prevents confused-deputy vulnerabilities.

Authorization is evaluated in the policy layer before dispatch, never inside a provider. Rate limits from `limits` are applied at the same point: per client, and per connection to protect vendor quota from an agent stuck in a retry loop.

---

## Security model

This system holds live credentials to the owner's email and documents. The security section is a first-class deliverable, and it states limits honestly rather than implying guarantees the code does not deliver.

### Protected assets

OAuth app secrets, connection refresh tokens and app passwords, client bearer tokens, the content returned through capabilities (message bodies, documents), audit records, and the configuration itself.

### Security goals

Prevent a client from reaching a connection it holds no grant for. Keep each connection's credential reachable only by its own provider invocation. Make every invocation attributable. Keep control-plane decisions outside agent reach.

Lanes Link does not attempt to guarantee correct agent behavior, continuous availability, or that a model will not disclose data it was legitimately given.

### Trust boundaries and operator assumptions

- **The owner controls** the machine or cloud project, the database, the credential store, the encryption key, and the config file. Lanes Link does not protect a deployment from a compromised owner environment.
- **Provider code is trusted code.** It runs in-process with core and holds its connection's credential. Installing a third-party provider is equivalent to running arbitrary code with access to that account. There is no provider sandbox in M1.
- **MCP clients are authenticated but untrusted in intent.** A client may attempt any capability; the policy layer decides. Compromise of a client's token grants exactly that client's grants, no more.
- **Content returned from upstream accounts is untrusted data.** An email body or document may contain prompt injection aimed at the consuming agent. Lanes Link passes content through and does not screen it. Screening, if ever added, belongs in an optional module and is explicitly out of scope here.
- **Upstream vendors** receive the requests made on the owner's behalf, subject to their own retention policies.

### What the controls do and do not guarantee

Policy evaluation, scoped state, scoped secrets, and audit are designed to reduce cross-connection access and make actions attributable. They are not a proof of non-interference.

Audit records support investigation; they do not prevent an action. Encryption at rest protects stored material from direct reads, not plaintext in a running process. Rate limits blunt runaway loops; they are not a security boundary.

### Known limitations (M1)

- **Bearer tokens are bearer authorization.** Anyone holding the profile token is that profile's principal. Tokens are not bound to a device. Revocation means rotating the token and reconciling, which re-authorises every agent on that profile.
- **Agent config files are a real exposure.** MCP client configuration often sits in plaintext on disk, so a client token is roughly as protected as that file.
- **Rate limits are per instance.** On a horizontally scaled serverless deployment they are not global. A shared counter store would be needed for that; it is not in scope.
- **No egress control.** A provider may contact any host. This follows from provider code being trusted.
- **No secret scanning on write**, and no provider sandbox.
- **Consent-screen friction** for an unverified Google production app, as described in the OAuth section.
- **Content leaving the boundary is not recoverable.** Lanes Link governs what an agent may fetch, not what happens to it afterward.

### Supply chain

This project holds long-lived credentials, so dependency compromise is a live threat.

- Set `minimumReleaseAge = 604800` (seven days) in `bunfig.toml` so newly published versions must age before entering the lockfile. This blunts the common pattern where a compromised package is published and yanked within hours. **Verified rather than assumed:** `bun add hono` resolves to the newest release older than the floor, not to `latest`.
- Pin the Bun version in `.bun-version`. Commit the lockfile. CI installs with `bun install --frozen-lockfile`. Run `bun pm scan` for lockfile CVEs.
- Urgent security fixes may be pulled in ahead of the window by installing an exact version explicitly, or via `minimumReleaseAgeExcludes`.

> **Amended.** The original text specified npm (`.npmrc`, `npm ci`, `.node-version`). Bun provides
> the same release-age floor plus a lockfile vulnerability scanner, so the supply-chain control is
> strictly stronger rather than traded away. This deviates from "TypeScript and Node.js" below;
> bun-specific APIs are confined to two files so reverting would touch only those.

Write `SECURITY.md` with a private reporting path. Do not accept vulnerability details in public issues.

---

## Guarantee status

Maintain this table and keep it honest. `ENFORCED` means code rejects or tests the property today. `VALIDATED-ONLY` means config is checked but runtime enforcement is absent. `RESERVED` names a compatibility slot with no implementation. `NOT-GUARANTEED` names a documented limitation.

| Property | Status (M1 target) | Verifier |
|---|---|---|
| `policy.default-deny` | ENFORCED | policy evaluation tests |
| `policy.tighten-only` | ENFORCED | policy composition tests |
| `control-plane.not-agent-reachable` | ENFORCED | capability registry assertion test |
| `config.contract-major-fails-closed` | ENFORCED | loader test |
| `config.no-secret-values` | ENFORCED | validator test with credential fixtures |
| `credentials.connection-scoped` | ENFORCED | `ScopedCredentials` isolation test |
| `state.provider-scoped` | ENFORCED | `ScopedStore` isolation test |
| `audit.every-invocation` | ENFORCED, one documented exception | dispatch-path test; see `docs/detailed/security.md` |
| `audit.redaction` | ENFORCED | provider redaction tests, including on denials |
| `audit.append-only` | ENFORCED | store interface has no update or delete |
| `discovery.policy-filtered` | ENFORCED | `tools/list` **and** `server/discover`, over the wire |
| `transport.stateless` | ENFORCED | no server-side session state; restart-mid-session test |
| `profile.isolated` | ENFORCED | cross-profile token, state, and audit tests |
| `credentials.encrypted-at-rest` | ENFORCED (local file adapter) | adapter test |
| `limits.per-profile` | ENFORCED per instance | rate limit test, with the scaling limit documented |
| `credentials.plaintext-in-use` | NOT-GUARANTEED | documented limitation |
| `provider.sandboxed` | NOT-GUARANTEED | documented limitation |
| `egress.controlled` | NOT-GUARANTEED | documented limitation |
| `policy.approval_required` | RESERVED | model carries the state; no engine |
| `delegation.external-clients` | RESERVED | `principal` and `granted_by` fields exist |

---

## Infrastructure adapters

| Interface | `local` target (M1) | `cloud` target (M2) |
|---|---|---|
| `Database` | SQLite | Postgres |
| `SecretStore` | encrypted file | Google Secret Manager |
| `BlobStore` | filesystem | deferred |

`AuditStore` is an interface over `Database`, not a separate backend.

`BlobStore` has no consumer in M1 or M2: the example and Gmail read providers store no bytes. Define the interface and the filesystem adapter, and add GCS when a provider actually writes bytes. Do not build S3, Azure, or Vault adapters. Do not add `Cache`, `Queue`, or `SearchIndex` until something needs them.

SQLite and filesystem are production-capable for single-user local use, not mocks.

**Postgres host is a deploy-time choice, not an architectural one.** The adapter needs only a connection string. Cloud SQL runs continuously and will dominate the cost of an otherwise scale-to-zero deployment; a serverless Postgres with a free tier is cheaper for single-user use. Note the tradeoff in the deployment doc.

**Cold starts:** with minimum instances at zero, the first agent call after idle pays container start plus database connect. Accept it, or set minimum instances to one and accept the cost. Document the choice.

### Provider context

Providers receive scoped capabilities, never raw backends. A provider must not be able to read another provider's state or another connection's credential.

```typescript
interface ProviderContext {
  state: ScopedStore;       // namespaced to provider + connection
  storage: BlobStore;       // namespaced to provider + connection
  credentials: ScopedCredentials; // read-only, this connection's refs only
  audit: AuditLogger;
  log: Logger;
}
```

---

## Provider SDK

The provider authoring experience is the most important internal interface, and it matters more because external contributors will use it. A provider declares metadata, a configuration schema (Zod), a connection schema, authentication requirements, tools and resources, permission identifiers, and its redaction rules for audit.

A provider must be writable without reading the rest of the codebase, and installable without editing core. Built-in providers may be statically imported for now, but preserve the path to independently versioned packages (`lanes link add <provider>` later). The example provider must be small enough to reproduce verbatim in `docs/detailed/creating-a-provider.md`.

Because provider code is trusted (see Security model), `docs/detailed/creating-a-provider.md` must state plainly what a provider can reach and what installing a third-party provider implies.

---

## Repository structure

> **Superseded.** This section described the workspace layout as originally
> planned. It is kept because the rest of this document argues from it, but the
> repository is one package under `src/` now — see
> [`architecture.md`](architecture.md) for the current table and
> [ADR-015](adr/015-one-package-under-src.md) for why it changed.

```
/
  src/
    cli/               # lanes-link CLI — the control plane
    server/            # Bun.serve, bearer auth, and the MCP surface
    profile/           # what a profile is: schema, loading, workspace layout
    registry/          # what exists: providers, capabilities, reconcile
    dispatch/          # how one call runs: context, policy, limits, audit
    policy/            # rule evaluation, floor composition
    audit/             # audit writer + redaction
    auth/              # endpoint identity: token to principal
    stores/            # Database and BlobStore contracts
    secrets/           # one document format, two stores: system and vault
    connectivity/      # transports/ and auth/, one folder per option
    providers/         # every provider, one folder each
    deployments/       # adapters/, local/, gcp/, azure/
  docs/
    adr/
  skills/
```

TypeScript on **Bun**, MCP SDK v2, Zod for schemas, and `bun:sqlite` directly for typed database access — the schema is four tables and every query is single-table, so an ORM would add a dependency and a migration toolchain for nothing this code needs. Modular monolith. No Kubernetes, Redis, Kafka, Temporal, or microservices.

Bun-specific APIs are confined to `src/deployments/adapters/sqlite.ts` and `src/server/index.ts`; everything else is portable TypeScript.

---

## CLI

The CLI is the control plane and the only path to control-plane operations. It calls the same core APIs a future web UI would; business logic never lives in a command.

### Workspace and profile selection

A **workspace** is a directory holding one or more profiles:

```
lanes-link.yaml      # workspace settings: contract, default_profile
profiles/
  personal.yaml
  work.yaml
data/               # local state per profile, gitignored
```

Workspace root resolves from `LANES_LINK_HOME`, else the nearest ancestor directory containing `lanes-link.yaml`, else `~/.lanes-link`.

Profile resolves from `--profile <name>`, then `LANES_LINK_PROFILE`, then `default_profile` in the workspace file, then an error listing available profiles. A profile name maps to `profiles/<name>.yaml`.

Target resolves from `--target <name>`, defaulting to `instance.default_target`. `lanes link start` implies `local`; `lanes link deploy` implies `cloud`.

**Every command prints the resolved profile and target before acting**, read-only commands included. This is the primary guard against operating on the wrong instance, and it costs one line.

Do not implement a sticky `lanes link use` that persists a current selection. Persisted context state is the standard way operators run destructive commands against the wrong target. `export LANES_LINK_PROFILE=work` gives the same convenience while remaining visible in the shell.

Profile management: `lanes link profile add <name> [--default]`, `lanes link profile list`, `lanes link profile remove <name>`, `lanes link profile default <name>`.

### Command groups

> **Amended.** Four commands to add one account was the config's internal structure leaking into the
> UX. **`lanes link connect <provider>` is the one command**, run once per account:
>
> ```
> lanes link connect gmail          # first run  → prompts for client id/secret, then browser
> lanes link connect gmail          # every run after → straight to browser, another account
> lanes link connect example        # same command, no browser: the provider declares no auth
> ```
>
> It enables the provider, runs first-time setup only if this profile has not done it, opens consent,
> names the connection after the account the token identifies, grants the provider's **default
> bundle**, and prints the config diff. A second run skips whatever the first established.
>
> Granting a default bundle does not weaken default deny: explicit allow lines are written into the
> file and shown. The runtime is still deny-unless-listed.
>
> `provider enable`, `connection add`, and `oauth-app add` still exist underneath as scriptable
> escape hatches — they are simply no longer the path a human walks. `client` commands are gone with
> the `Client` entity; `lanes link token show|rotate` manages the profile's single token.

**Config-editing (writes YAML, touches nothing else).**

```
lanes link connect <provider>                  # the everyday path; writes all of the below
lanes link policy allow "gmail.*" gmail.main
lanes link policy deny  gmail.send gmail.main
lanes link connection add gmail.side --display-name "Side projects"   # scripting escape hatch
lanes link provider enable gmail --oauth-app google                   # scripting escape hatch
lanes link target set cloud --project P --region R --service S
```

Each validates the resulting document before writing, so the file is never left invalid. Connection arguments use the `provider.id` notation used everywhere else.

**Credential-writing (writes to the target's credential store).**

```
lanes link connect gmail.side                  # re-authorises one existing account
lanes link connect gmail.side --add write      # widening scope needs browser re-consent
lanes link token show [--show] | lanes link token rotate
lanes link secrets push --from local --to cloud
```

`connect` refuses a connection that is not declared in the resolved config, so a typo cannot create an orphaned credential. Config declares; `connect` authorizes.

**Tightening is local and instant; widening a vendor scope needs consent.** That asymmetry is
inherent to OAuth, not a design choice, and it is why bundles name both layers at once.

**Gate order**, so failures surface in the cheapest place first:

```
lanes link check     # static: config schema, validation rules, no external calls
lanes link doctor    # read-only external: secret refs resolve, tokens valid, database reachable
lanes link plan      # print what reconcile would change; no mutation
lanes link start     # apply reconcile, serve /mcp locally
lanes link deploy    # apply to the cloud target
```

`doctor` treats missing or placeholder required values as failures, and reports optional gaps without blocking.

**Inspection:** `status`, `provider list`, `connection list`, `client list`, `policy list`, `audit tail`, `outputs`.

### The deploy loop

The intended working rhythm:

```
lanes link connection add gmail.side  # edit config
lanes link connect gmail.side --target cloud  # authorize into Secret Manager
lanes link check && lanes link plan                   # confirm what changes
lanes link deploy                             # build, push, roll a revision
lanes link outputs                            # public URL + client tokens for agent config
```

`lanes link deploy` is a thin wrapper, not a deployment engine: run `check`, build the container with the config baked in, push it, ensure declared secrets exist, deploy the Cloud Run service, wait for health, then print the public URL. Roughly one file. Do not build plan-and-apply state files, deploy leases, drift reconciliation, or a rollback manifest; Cloud Run revisions already provide rollback, and that machinery belongs to multi-target org deployment tools rather than a single-user instance.

Baking config into the image keeps deployment immutable and gives one mechanism instead of two, at the cost of a rebuild per config change. If that latency becomes annoying, mounting the config as a Secret Manager version and rolling a revision without a rebuild is the optimization to reach for, but only then.

`lanes link outputs` prints the service URL and, on request, each client's bearer token, which is what an agent's MCP configuration needs.

**`docs/detailed/workflow.md` is the normative CLI user experience.** It walks the full lifecycle end to end, including multi-profile setup, and shows expected output for each command. Implement against it, and keep it updated when a command changes.

---

## Milestone map

The numbering below shifted once. **M2 was originally Cloud Run**; building the second provider
showed that the per-provider package model would not survive four more, so the connector model was
inserted as M2 and everything after moved down one. Doing it before deployment meant neither Cloud
Run nor the owner layer got built against a shape that was about to be replaced.

| | | |
|---|---|---|
| M1 | local vertical slice | ✅ done |
| **M2** | **the connector model** — a provider is a manifest ([ADR-008](adr/008-connectors.md)) | ✅ done |
| M3 | Cloud Run | ✅ done |
| M4 | the owner layer — memory, skills, vault | ✅ done |
| M5 | managing the owner layer — a CLI, a skill write path, one storage shape ([ADR-014](adr/014-owner-layer-is-managed.md)) | ✅ done |
| M6 | expanding — more providers, and the bunq `AuthStrategy` | |

M5 was not on this list. It is here because M4 shipped three providers and no way to manage any of
them: the two stores holding the owner's own data were reachable only by an agent, and the one thing
that shapes agent behaviour was reachable only by editing a file and restarting. The milestone that
fixed that also found the vault had no cloud adapter at all — see the M5 section below.

"Provider expansion" stopped being a milestone of its own along the way: adding Slack or HubSpot is
now a manifest rather than a project, which is the outcome that justified the detour.

---

## Milestone 1: local vertical slice

**Goal: a working MCP endpoint on the developer's machine, usable from a real agent.** Everything in M1 runs locally. No cloud.

1. Stateless streamable HTTP server on `/mcp`.
2. Config loader with all validation rules, plus reconcile and drift reporting.
3. `Database` (SQLite), `SecretStore` (encrypted file), `BlobStore` interface plus filesystem adapter.
4. Provider registry and connection registry.
5. Principal identity via the profile bearer token; default-deny policy evaluation with tighten-only composition; per-profile and per-connection rate limits.
6. Audit logging, append-only, with provider-controlled redaction.
7. Example provider: trivial, no third-party service, serves as the SDK reference.
8. Gmail provider with read capabilities (`search`, `get_message`, `get_thread`, `list_labels`) and three connections.
9. CLI as specified above, including the config-editing commands. Config writes must preserve comments and key ordering, and must validate the resulting document before writing.
10. Tests per the testing section, including the control-plane exclusion assertion.
11. `docs/detailed/architecture.md`, `docs/detailed/creating-a-provider.md`, `docs/detailed/security.md`, `SECURITY.md`, `README.md`, and the guarantee status table.

**Done when:** with three Gmail accounts connected by running `lanes link connect gmail` three times, Claude connects to the local endpoint, discovers the tools, and searches each account separately. A second **profile** with narrower policy can reach only what its rules allow, is denied the rest, cannot discover the connections or capabilities it lacks, and every call appears in the right audit log.

*Both stages are complete and verified end to end. Stage 1: two profiles on separate ports, differing
tool lists, isolated state, cross-profile token rejection, and refusals recorded — with no credentials
of any kind. Stage 2: the Gmail provider, CLI-side PKCE loopback OAuth, per-connection access tokens
cached in memory only, and the search query withheld from the audit log.*

Write capabilities are out of scope. Read access is sufficient to prove the architecture.

## Milestone 2: the connector model

**Goal: a provider costs a manifest, not a package.** `providers/gmail` had reached 612 lines for
one read-only integration — four times `src/policy`, which is the thing that justifies the
project.

Recorded in full as [ADR-008](adr/008-connectors.md); the shape is three connector kinds (`mcp`,
`http`, `local`), capabilities discovered rather than declared, and the same manifest schema whether
it arrives as a typed module or as YAML an operator wrote. [ADR-009](adr/009-one-endpoint-per-workspace.md)
covers the endpoint change made late in the milestone, which reduces what the system guarantees and
says so.

---

## Milestone 3: Cloud Run

**Goal: the same M1 slice, unchanged at the application layer, running on Cloud Run.**

1. `Database` Postgres adapter.
2. `SecretStore` Google Secret Manager adapter.
3. Dockerfile under `src/deployments/gcp/`, plus `lanes link deploy` and `lanes link outputs` as specified in the CLI section.
4. `lanes link secrets push --from local --to cloud` for migrating a locally built setup.
5. Endpoint protected by bearer token, optionally behind Cloud Run IAM.
6. `docs/detailed/deployment-cloudrun.md`, covering the Postgres host choice, cost, and cold starts.
7. Update the guarantee status table where scaling changes a status (rate limits in particular).

**Done when:** the same config, with only the target switched, runs on Cloud Run and serves the same agents with the same permissions. No application-layer code differs between M1 and M2, and the full loop of adding a connection, authorizing it, deploying, and using the printed URL from an agent works end to end.

## Milestone 4: the owner layer — Memory, Skills, Vault

> **Amended.** This milestone is new, and it is deliberately ordered **before** broad provider
> expansion. Memory, skills, and vault need **zero** third-party integration — no OAuth, no vendor
> APIs, no rate limits — so they are less work than M5 while being the actual differentiation.
> Notion and Slack connectors are commoditized; this layer is not. M3 depends only on M1, so it can
> run in parallel with M2.

Three owner providers, all local:

- **`memory`** — the owner's accumulated knowledge. Resources for retrieval by address, plus
  `memory.search`. `memory.write` is a *separate* capability from read, precisely so read-only agents
  are a real configuration.
- **`skills`** — reusable procedures, on the MCP prompts primitive reserved in M1. Authored as files
  in `<workspace>/skills/`, the way custom providers are files in `<workspace>/providers/`; there is
  no capability that writes one.
- **`vault`** — the owner's secret material. Tools only, never resources: resources are listable and
  cacheable, which is wrong for secrets. Default deny, per-item policy, aggressive audit redaction.
  Per-item is reached by making the item id part of the capability name, so an item written today is
  readable only after a restart — a write cannot hand itself a read.

~~**Nothing in core changes to add them.**~~ They register through the same provider SDK, are
configured by the same `lanes link connect <provider>`, are scoped by the same profiles, and are gated by the
same policy evaluation. That claim was the real test of the M1 architecture — if it fails, M1 was
wrong.

> **It was false, and the correction is worth more than the claim was.** Struck through rather than
> deleted, because it was written as a prediction to be tested and quietly editing it would destroy
> the only interesting thing about it.
>
> **What held.** Everything the sentence after it asserted. The three providers are ordinary
> `defineLocalProvider` registrations; no connector kind was added; dispatch still evaluates policy
> once, before a provider is reached, and still writes exactly one audit event per invocation. The
> owner layer needed no concept that did not already exist.
>
> **What did not.** Two of the three capability kinds had a type, a registration site, and **no
> runtime at all**. `src/connectivity/transports/local.ts` filtered `discover()` to `isTool` and threw
> `"is not a tool"` from `invoke()`; the resource path in `src/server/mcp` therefore dispatched into
> that throw, and had two further faults besides — it passed the URI as a string, so the SDK took the
> static-resource overload and the placeholder was never expanded, and it substituted the literal
> token `{key}`, so any provider naming its variable anything else registered a URI with no routing
> in it and two connections would have collided on one address. There was no `resources/list` and no
> prompts branch. `DispatchOutcome` knew only `ToolResult`. `redact` sat on `ToolCapability`, so a
> resource read could not declare what survives into the audit log.
>
> The visible consequence: **`example://note/{key}` was declared in M1 and unreadable ever since**,
> with no test to say so. `ResourceCapability.read` had no caller and `ResourceCapability.list` had
> none either.
>
> That is a different failure from a wrong shape, and much cheaper — plumbing, not architecture. But
> "nothing in core changes" was not true, and a milestone that had simply *used* the owner providers
> to discover it would have been a worse outcome than one that says so. The full account, with the
> three decisions taken before any of it was written, is
> [ADR-012](adr/012-owner-layer-primitives.md).

Two problems to solve before building it, recorded now rather than discovered late — both answered in
[ADR-012](adr/012-owner-layer-primitives.md):

1. **Are skills read or invoked?** They can be both, and the answer decides whether they are prompts,
   resources, or tools. *Answered: invoked, so prompts. The discriminator is whether the answer
   depends on arguments — a resource is a function of its URI alone. A skill is therefore also
   authored as a file rather than written by a capability, which removes problem 2 for skills
   entirely rather than mitigating it.*
2. **Writable memory is an injection persistence channel.** Content returned from upstream is already
   treated as potentially prompt-injecting and passed through unscreened. Owner-authored memory an
   agent can *write to* changes the risk: an injected instruction can be stored once and re-served to
   every future session, including to a different agent. Read-only memory does not have this
   property, which is the strongest argument for `memory.write` being separate and default-denied.
   *Answered: separate ids in a non-default bundle. Note what "default-denied" does and does not mean
   — the engine grants nothing without a rule, but `lanes link connect` still writes `allow: ['memory.*']`
   into your file. Narrowing it is one `deny` line, or a second profile.*

A third question the vault raised, which was not on this list: **per-item policy is not expressible**
against a policy engine that matches `*`, `provider.*`, and exact names and carries no arguments.
Answered by putting the item id in the capability name — `vault.get.github_token`, which that
grammar already handles — rather than by teaching policy about arguments, which
`src/profile/schema.ts` warns against by name.

## Milestone 5: managing the owner layer

> **Not on the original map.** M4 shipped three providers and no way to manage any of them, and the
> gap was invisible from inside M4 because every M4 test drove them over MCP. What it looked like
> from outside: to put a password in the vault you asked a language model to type it. All of this is
> [ADR-014](adr/014-owner-layer-is-managed.md).

Three things, and only the first was foreseen.

**A control plane.** `lanes link memory`, `lanes link skills`, `lanes link vault`. `docs/detailed/workflow.md` — which this document
calls the normative CLI experience — had no command for any of the three and never did, so this was
never a regression, just something specified nowhere.

**A skill write path.** ADR-012 §1 refused one: a skill is instructions, so an agent able to author
one could persist its own future behaviour. The argument survives; the conclusion did not. ADR-012 §2
had already met the same threat in memory and answered it with a separate capability in a non-default
bundle, and two providers with one threat and opposite answers is an inconsistency rather than a
posture. Authoring is now `skills.manage.*`, out of the default bundle, with *reading* a skill's body
in the author half so the self-selection argument in §1 still holds for everyone else.

That forced a second thing ADR-012 had accepted: skills were fixed for the life of the process.
Tolerable when adding one meant an operator editing a file; not tolerable when a granted agent writes
one and finds no prompt. `ProviderRegistry.replace` and a bounded poll fix it, for skills only — the
vault deliberately still requires a restart, because there "a write cannot hand itself a read" is the
property rather than the delay.

**A bug, found on the way.** `openRuntime` built `createFileVaultStore` unconditionally — no target
switch, unlike credentials, database, and storage. On Cloud Run every vault item was written to a
container filesystem the next revision discarded, silently. The same failure ADR-013 fixed for blobs,
still present in the one store holding the owner's passwords. All three owner stores now follow the
target, and a memory entry became one Markdown file rather than an index row beside a body blob.

## Milestone 6: expanding

Not before M3 is done. Two strands.

**The `AuthStrategy` seam and bunq.** The seam exists and fails loudly; the RSA keygen, three-step
handshake, per-request signing, and response verification are unwritten. Sandbox first — it touches
a bank account — and local target only until the permitted-IP and session constraints are designed
against M3.

**More accounts.** Owner's target stack:

- *Personal:* 3 Gmail, 1 iCloud Mail, Notion across 3 accounts, Drive across 3 accounts
- *Work:* 1 Gmail, 1 Drive, Notion, Slack

Notion, Drive, Linear, and Gmail landed in M2 as manifests rather than as this milestone's work.
What remains is Slack and iCloud Mail.

iCloud Mail is deliberately last of the read providers. IMAP is connection-oriented and fights a stateless serverless runtime, requiring re-authentication per cold instance. It is the real test of whether the authentication abstraction holds, and it should be attempted only once the architecture is settled.

---

## Testing

Cover: provider registration; multiple-connection isolation; policy default-deny and tighten-only composition; the control-plane exclusion assertion (no registered capability maps to policy, token, credential, config, connect, or audit mutation — including a rogue provider proving the assertion can fail); credential boundaries (a provider cannot read another connection's credential, the profile token, or an undeclared app secret); scoped state isolation; rate limit enforcement; database adapter behavior; config validation for every rule, including credential-shaped-value fixtures and an unknown contract major; reconcile paths for undeclared connections and missing credentials; drift reporting in both directions; tool routing and connection argument resolution; audit redaction and append-only behavior; capability discovery filtered by policy across both `tools/list` and `server/discover`; cross-profile isolation of tokens, state, and audit.

Also cover the CLI config-editing path: each mutating command produces a valid document, preserves comments and ordering, keeps a grown collection readable rather than collapsing it to one line, is idempotent when re-run, and leaves the file untouched when validation fails. Cover target resolution, including that the same config produces the correct adapter set per target and that an undeclared target fails.

Integration tests for the example provider and Gmail. Gmail tests mock OAuth and the API.

---

## Documentation

Write alongside the code: `README.md`, `docs/detailed/architecture.md`, `docs/detailed/workflow.md`, `docs/detailed/configuration.md`, `docs/detailed/providers.md`, `docs/detailed/creating-a-provider.md`, `docs/detailed/security.md`, `docs/detailed/local-development.md`, `docs/detailed/deployment-cloudrun.md`, `CONTRIBUTING.md`, and `SECURITY.md`.

`docs/detailed/workflow.md` is supplied as part of this specification and defines the CLI contract; it is normative rather than illustrative.

The provider creation guide is the highest-value document: a developer should add a provider from it without reading the rest of the codebase.

ADRs: `001-connection-routing`, `002-transport-and-statelessness`, `003-auth-model`, `004-declarative-config`, `005-oauth-connection-flow`, `006-tools-versus-resources`, `007-control-plane-exclusions`. These decisions are already made in this document. Transcribe them with their reasoning; do not re-litigate them.

---

## Before writing implementation code

1. Inspect the current official MCP specification and SDK. Confirm the transport, authorization, and resource conventions this document assumes, then pin the SDK version.
2. Confirm the Google OAuth publishing and scope requirements described above.
3. Define the provider interface, the `ProviderContext` scoping, and the infrastructure adapter interfaces.
4. Define the config schema, the validation rules, and the reconcile algorithm.
5. Write `docs/detailed/architecture.md`, then implement M1.

When a choice is uncertain, optimize for portability, extensibility, security, simple provider development, minimal coupling, and user ownership. Do not optimize for enterprise scale. Do not add abstractions that do not serve a stated requirement here.

---

## Appendix: out of scope, keep the architecture open to it

**Future providers:** Outlook, Google Calendar, Apple Calendar, Dropbox, OneDrive, Sheets, GitHub, Linear, HubSpot, Revolut and banking, contacts, photos, home automation, custom REST APIs, and arbitrary user modules.

**Future composed modules:** a `unified_mail` module exposing `mail.search` over Gmail, iCloud, and Outlook; an `invoice` module over files and expenses. All optional, all additive, none in the core. *(`personal_memory` has been promoted out of this appendix into M3.)*

**Delegated external access.** Today every client belongs to the owner. A future capability lets the owner grant a scoped, revocable, time-boxed slice of an instance to an external party: a person, an assistant, or a company agent. Example: granting only `google_calendar.read` on one connection to a colleague's assistant, and nothing else. Not a milestone item, but the design must not foreclose it. The day-one constraints that keep it open are already in this spec:

- client identity supports many distinct credentials, not one shared owner secret
- `Client` carries optional `principal` and `granted_by`
- policy rules are revocable, scoped to one capability on one connection, with optional `expires_at`
- policy composition is tighten-only, so a delegate can never exceed the floor
- control-plane operations are unreachable from MCP, so a delegate's agent cannot widen its own grant
- audit records the acting client and, for delegated access, who granted it
- the no-token-passthrough rule prevents a delegate from exceeding its grant
- the reserved `approval_required` state fits sensitive delegated actions

Revocation and complete audit are the load-bearing parts. Note also that the owner remains a privileged reader of everything a delegate does; state that plainly when the feature ships. Granting third parties access to personal or work data carries EU data-protection implications to handle deliberately.

**Future CLI:** a named context registry mapping short names to config paths, added as an additional step in the existing resolution order once managing several remote deployments makes file paths tedious. If it ships, keep the printed target line and require explicit confirmation for mutating commands whose target came from persisted state rather than a flag or environment variable.

**Future infrastructure:** additional cloud adapters (S3, Azure, Vault, 1Password), a provider registry, a shared counter store for global rate limits, optional content screening for untrusted upstream data, and a management web UI operating on the same core APIs as the CLI. Do not build these now.