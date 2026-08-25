# Security model

This system holds live credentials to the owner's email and documents. This document states its
limits honestly rather than implying guarantees the code does not deliver.

To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md). Please do not open a public issue.

## Protected assets

OAuth app secrets, connection refresh tokens and app passwords, the profile bearer token, the content
returned through capabilities (message bodies, documents), audit records, and the configuration
itself.

## Goals

Prevent a caller from reaching a connection it holds no grant for. Keep each connection's credential
reachable only by its own provider invocation. Make every invocation attributable. Keep
control-plane decisions outside agent reach.

Lanes Link does **not** attempt to guarantee correct agent behaviour, continuous availability, or
that a model will not disclose data it was legitimately given.

## Trust boundaries

- **The owner controls** the machine or cloud project, the blob store, the credential store, the
  encryption key, and the config file. Lanes Link does not protect a deployment from a compromised
  owner environment.
- **Provider code is trusted code.** It runs in-process with core and holds its connection's
  credential. Installing a third-party provider is equivalent to running arbitrary code with access
  to that account. **There is no provider sandbox.**
- **Clients are authenticated but untrusted in intent.** A client may attempt any capability; the
  policy layer decides. Compromise of the profile token grants exactly that profile's grants.
- **Content returned from upstream accounts is untrusted data.** An email body or document may
  contain prompt injection aimed at the consuming agent. Lanes Link passes content through and does
  not screen it. Screening, if ever added, belongs in an optional module.
- **Upstream vendors** receive the requests made on the owner's behalf, subject to their own
  retention policies.

## The two kinds of secret

This distinction is the most important one in the codebase, and collapsing it would be the most
damaging single mistake available.

| | **Credentials** (`SecretStore`) | **Vault items** (M3) |
|---|---|---|
| What | refresh tokens, app-specific passwords, pasted API tokens, the profile token, and an OAuth client secret where the operator registered one of their own | the owner's own passwords, API keys |
| Authorises | the system itself | nothing — they are data the owner stores |
| Agent-reachable | **never, in any form** | yes, under policy, default deny |
| Store | encrypted file, its own key | separate store, **separate key** |

If an agent could read the Gmail refresh token it would simply call Google directly, and the entire
policy layer would become decorative. That is why the infrastructure interface is called
`SecretStore` rather than "secrets", why `Vault` will be a separate provider over a separate
store, and why a test asserting **Vault can never reach SecretStore** exists in M1, before the
vault does.

## What the controls do and do not guarantee

Policy evaluation, scoped state, scoped credentials, and audit are designed to reduce cross-connection
access and make actions attributable. They are **not** a proof of non-interference.

Audit records support investigation; they do not prevent an action. Encryption at rest protects
stored material from direct reads, **not plaintext in a running process** — a credential is in memory
whenever a provider makes a call, and that limit is inherent. Rate limits blunt runaway loops; they
are not a security boundary.

## Guarantee status

`ENFORCED` means code rejects or tests the property today. `NOT-GUARANTEED` names a documented
limitation. `RESERVED` names a compatibility slot with no implementation.

| Property | Status | Verifier |
|---|---|---|
| `policy.default-deny` | ENFORCED | `src/policy/index.test.ts` |
| `policy.tighten-only` | ENFORCED | policy composition tests |
| `policy.deny-beats-allow` | ENFORCED | asserted in both rule orders |
| `control-plane.not-agent-reachable` | ENFORCED | `src/dispatch/control-plane.test.ts` |
| `config.contract-major-fails-closed` | ENFORCED | loader tests |
| `config.no-secret-values` | ENFORCED | validator tests with credential fixtures |
| `credentials.connection-scoped` | ENFORCED | `ScopedCredentials` isolation tests |
| `credentials.not-agent-reachable` | ENFORCED | context surface assertion |
| `state.provider-scoped` | ENFORCED | `ScopedStore` isolation tests |
| `storage.namespace-contained` | ENFORCED | traversal rejection tests |
| `deployed.config-not-self-writable` | ENFORCED (deployed target) | the revision's `objectAdmin` grant is conditioned on the prefixes it owns, so `profiles/`, `lanes-link.yaml` and each profile's `providers.d/` are readable and not writable. The last of those sits *inside* the granted `data/` prefix since [ADR-030](adr/030-a-profile-owns-its-skills-and-manifests.md), so the condition carries an explicit exclusion rather than simply not naming it. Enforced by the platform; `src/deployments/grants.test.ts` evaluates the shipped expression — not a scan for prefixes, which would read straight past a negation — and asserts the keys the endpoint writes fall inside it and the config paths fall outside. This replaces the read-only image that carried the guarantee before [ADR-023](adr/023-the-workspace-is-not-in-the-image.md) |
| `audit.append-only` | ENFORCED | the store interface has no update or delete |
| `audit.tamper-evident` | ENFORCED **for edits and mid-run removals** | records are hash-chained per run; `lanes link audit verify`. Truncating a run killed mid-write, or deleting a run whole, is not detectable — see [ADR-020](adr/020-the-log-is-objects.md) |
| `audit.redaction` | ENFORCED | provider redaction tests, including on denials |
| `discovery.policy-filtered` | ENFORCED | `tools/list` and `server/discover`, over the wire |
| `setup.reports-only-reachable` | ENFORCED | `src/server/setup-surface.test.ts`; a denied connection reads as one never made |
| `setup.no-credential-presence` | ENFORCED | `missingRequirements` is CLI-only; the surface reports requirements, not what is stored |
| `transport.stateless` | ENFORCED | restart-mid-session test |
| `credentials.encrypted-at-rest` | ENFORCED (file adapter) | nothing readable on disk; tamper detection |
| `profile.isolated` | ENFORCED | cross-profile token, state, and audit tests, plus `src/cli/runtime/scoping.test.ts` for the owner layer. Two things were shared until [ADR-030](adr/030-a-profile-owns-its-skills-and-manifests.md) — skills and provider manifests, both at the workspace root — so this row was previously true of credentials, state and the log rather than of everything a profile holds |
| `oauth.refresh-replay-is-refused-and-recorded` | ENFORCED | a spent refresh token is tombstoned rather than deleted, so presenting it again is detectable; the replayed token is refused, the replay is logged, and the family it belongs to keeps working — tested over real HTTP in `src/server/oauth.test.ts` from any depth in the chain. Revoking the whole family instead is what [ADR-035](adr/035-a-replayed-refresh-token-must-not-log-the-owner-out.md) reversed, and what it gives up is stated there: a family is minted once and never rotates, so the old answer logged an approved client out roughly daily and a thief never |
| `token.rotation-takes-effect` | ENFORCED **within a five-second window** | `src/auth/index.test.ts` covers both halves against a real credential store: the replacement is accepted on its first call, and the rotated-away token stops working once the window passes. Both caches are dropped together — the authenticator's and the credential store's — because dropping only one re-reads the same stale value |
| `limits.per-profile` | ENFORCED per instance | rate limit tests |
| `audit.every-invocation` | ENFORCED **with two documented exceptions** | see below |
| `credentials.client-secret-never-local` | ENFORCED (hosted client) | there is no client secret on the machine to hold. `resolveSecretRefs` grants no client reference at all for a connection authorised this way, asserted in `src/dispatch/context.test.ts` |
| `credentials.exchange-is-local` | **NOT-GUARANTEED for a connection authorised against the hosted client** | see below |
| `credentials.plaintext-in-use` | NOT-GUARANTEED | inherent |
| `provider.sandboxed` | NOT-GUARANTEED | provider code is trusted |
| `egress.controlled` | NOT-GUARANTEED | follows from the above |
| `policy.approval_required` | RESERVED | the model carries the state; no engine, and it fails closed |
| `delegation.external-clients` | RESERVED | the principal parameter; nothing more |

### What `credentials.exchange-is-local` gives up

Since [ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md) a Google connection authorises,
by default, against an OAuth client Lanes operates rather than one the operator registers. That
removes a nine-step console walkthrough and the seven-day refresh-token expiry that comes with an
unpublished project. It also moves one step off this machine, and the honest statement of that is
worth more than the convenience:

- The **authorization code** is sent to the Lanes API, because redeeming it needs the client
  secret and that secret is deliberately not here.
- The **refresh token** comes back through the Lanes API, and passes through it again on every
  later refresh.
- An **identity assertion** (a Google `id_token`, obtained from the `openid` and `email` scopes
  the flow adds for this purpose) is sent with each refresh, so the API can attribute and
  rate-limit per account. It is stored beside the tokens and never decoded here.

Everything else is unchanged: the browser still talks to Google directly, the redirect still lands
on a loopback listener this process opened, the endpoint still never participates, and the tokens
still live in whichever credential store the config names.

**Nothing in this repository can verify what the Lanes API does with what it sees.** That is the
whole of the trade, and it is why this is a row in the table rather than a paragraph in a guide.
An operator who does not want to make it runs `lanes link connect <provider> --own-client` once
per profile, which registers a client of their own and keeps the exchange between this machine and
Google. Declaring `oauth_apps` in a profile is the same choice expressed in config, and a profile
that declares it is never moved off it.

### Failed authentication is logged, not audited

A refusal record needs a principal, and failing authentication is precisely not having one — so a
rejected credential cannot be an audit row without inventing a caller to attribute it to. It goes to
the endpoint's operational log instead: stderr for `lanes link start`, stdout for the container,
where Cloud Run collects it. The line names the reason (`invalid`, `malformed`, `missing`,
`not_configured`) and never the value presented.

This is a change. The warning was written from the start and every caller passed a logger whose
methods were empty, so on a public URL a sustained probe left no trace anywhere.

### The documented exceptions to `audit.every-invocation`

Every call that reaches dispatch is audited, allowed or denied. A call naming a **capability that
policy filtering hid** is also audited, via `Dispatcher.recordRefusal`. Two cases are not.

**Not audited: arguments that fail schema validation.** A call to an advertised tool whose
*arguments* are rejected — including a `connection` value outside the advertised enum. The protocol
layer rejects it before dispatch runs. The caller gets a clear error naming the permitted options,
and nothing is invoked, but no audit row is written.

Closing it would mean either dropping the enum from the tool schema — which is what makes connections
undiscoverable in the first place — or parsing the request body at the edge. Neither trade is
currently worth it.

**Not audited: a pre-envelope HTTP call to a hidden capability.** The refusal record for a
policy-filtered capability is written at the HTTP edge, which identifies the call by reading
`Mcp-Method` and `Mcp-Name`. The 2026-07-28 envelope requires both and rejects any request whose
headers and body disagree, so for an envelope client the header read is exact. A 2025-era client
sends neither header, and the endpoint still serves those requests — `createMcpHandler` is
constructed without a `legacy` option, and its default is `'stateless'`. So the refusal check
short-circuits, the legacy leg answers `-32602 Tool … not found`, and no row is written.

What that costs: an authenticated caller can enumerate which capabilities exist without leaving a
refusal trace, by speaking the older protocol. It is not reachable unauthenticated, and nothing is
invoked either way.

Closing it means reading the body at the edge for requests that arrive without the headers — a
`request.clone()` and a parse — which is precisely what `serveOverStdio` already does, because a pipe
has no headers to read instead. The alternative, `legacy: 'reject'`, closes it by refusing every
pre-envelope client, and several of the clients in [`docs/clients.md`](../clients.md) have not moved.

Both were found by end-to-end verification rather than reasoned about in advance, and both are
recorded here rather than papered over. `src/server/index.test.ts` asserts the second one directly,
next to the test that shows the envelope path recording the same probe.

## Upstream credentials

The server is its own OAuth client to each vendor and **never forwards an incoming bearer token
upstream**. A caller's token authenticates them to *this* endpoint and has no meaning at Google;
forwarding it is the confused-deputy mistake. The separation is structural rather than a rule to
remember — the caller's token never reaches provider code at all, and an integration test asserts
that what Google sees is only ever derived from the connection's own refresh token.

Access tokens are derived at runtime and **cached in memory only, never persisted**. They are
short-lived by design, so storing one would create a second credential to protect for no benefit.
The cache is keyed per connection, so two accounts never share a token, and a stateless server
starts cold with an empty cache.

**Not every upstream credential is an OAuth token, and the ones that are not are weaker in two
ways.** iCloud takes an app-specific password; GitHub and Slack take a token the operator generates
and pastes, because neither vendor's MCP server will register a client for us (ADR-033). Such a
credential is long-lived and *is* persisted — there is no refresh, so the stored value is the
credential itself rather than a means of obtaining one. Rotation is manual: `connect --replace`,
after revoking upstream.

The second difference is the one worth saying out loud. For an OAuth provider, `connect` shows what
is about to be granted and refuses to proceed if the scopes have widened without being agreed —
`confirmScopes` is that gate. There is no equivalent here, and there cannot be: what a pasted token
can do is chosen in the vendor's own console, and this endpoint has no way to read it back. So the
guarantee for these providers is narrower — the policy layer still bounds what an agent may *call*,
but the credential's own reach is the operator's to bound, at the vendor, when they create it. Both
setup pages say so at the point the token is generated.

**A Google Cloud project left in "Testing" publishing status expires refresh tokens after seven
days.** That is a policy setting, not a bug, but it presents as an authentication failure on a
weekly schedule — so `invalid_grant` is detected specifically and the error names the cause. See
[`setup/google.md`](setup/google.md).

## Known limitations (M1)

- **Bearer tokens are bearer authorization.** Anyone holding the profile token is the principal.
  Tokens are not bound to a device. Revocation means rotating the token and reconciling.
  A running endpoint notices a rotation within five seconds rather than instantly: the expected
  value is cached for that long so the common case is a comparison rather than a decrypt. The
  replacement works immediately — a token that does not match a cached value forces a re-read
  before it is rejected, which is what makes the rotated-in credential usable on its first call.
- **Agent config files are a real exposure.** MCP client configuration often sits in plaintext on
  disk, so a token is roughly as protected as that file.
- **One token per profile.** Two agents cannot hold different permissions against the same profile;
  they need separate profiles. Rotating re-authorises every agent on that profile. Audit attributes
  calls to the profile's principal, not to a specific agent — the recorded `clientInfo` label is
  self-reported and never consulted for authorization.
- **An authorised remote client is the owner.** Where `auth.authorization` is declared, a client that
  completed the flow resolves to the same owner principal the bearer token yields, so the scope it
  was granted is not a permission boundary — policy is. Revoking one client means deleting its tokens
  from the profile's state store; there is no per-client revocation command yet. See
  [ADR-018](adr/018-the-gate-is-in-the-application.md).
- **Anyone who can reach the endpoint can register a client.** Registration yields an identifier and
  nothing more: no client obtains a token without an approval performed by hand with the endpoint
  token. It does mean an unauthenticated caller can write rows, so the list is capped at 200 and the
  oldest without a live token are evicted — a connector in use is never dropped to make room.
- **Rate limits are per instance.** On a horizontally scaled deployment they are not global.
  This now includes a ceiling on *failed* authentication at the HTTP edge, which exists to bound
  the credential-store re-read a mismatch triggers rather than to make guessing harder — 256 bits
  already does that. Only a failure spends the budget, so a valid token is never refused by it.
- **No egress control**, no provider sandbox, no secret scanning on write.
- **Content leaving the boundary is not recoverable.** Lanes Link governs what an agent may fetch,
  not what happens to it afterwards.

## Supply chain

This project holds long-lived credentials, so dependency compromise is a live threat.

`bunfig.toml` sets `minimumReleaseAge = 604800` — seven days. The common attack is to publish a
compromised version and yank it within hours; a release-age floor keeps a version that young out of
the lockfile entirely. This is verified rather than assumed: `bun add hono` resolves to the newest
release older than the floor, not to `latest`.

Also: `bun pm scan` for lockfile CVEs, `bun install --frozen-lockfile` in CI, a pinned Bun version in
`.bun-version`, and a committed lockfile. An urgent security fix can be pulled in ahead of the window
by installing an exact version explicitly.

The runtime dependency set is deliberately small — MCP SDK v2 (`core` has one dependency), `zod`, and
`yaml`. Argument parsing is hand-rolled rather than delegated, because a dependency that parses argv
in a process holding credential-store keys is not worth the convenience.

## The owner layer's own risks

Recorded before the layer was built, and kept here with what was done about each.

**Writable memory is an injection persistence channel.** Upstream content is already treated as
potentially prompt-injecting and passed through unscreened. Owner-authored memory that an agent can
*write to* changes the risk: an injected instruction can be stored once and re-served to every future
session, including to a different agent. Read-only memory does not have this property, which is the
strongest argument for `memory.write` being a separate capability in a non-default bundle — which is
what it is.

**A written skill is the same risk, one turn earlier.** A skill is instructions an agent is later
handed as its own turn, so an agent that can author one can shape what it does next. ADR-012 §1 first
answered this by having no write path at all; [ADR-014](adr/014-owner-layer-is-managed.md) replaced
that with the same answer memory uses — `skills.manage.*`, out of the default bundle — for a reason
worth repeating here. Structural absence read stronger than it was: a skill file is writable by
anything running as the owner, so "no agent can write a skill" only ever meant "not through the one
path that evaluates policy and writes an audit event". Moving authoring inside that boundary made it
governable.

**Reading a skill is the narrower risk, and is still withheld by default.** `skills.manage.get` is in
the author bundle, not the read one, so an agent that can invoke skills cannot browse them for
instructions to give itself.

**Neither of these screens anything.** They separate a privilege. Nothing in this codebase detects an
injection, and no part of it claims to.

**`lanes link connect` grants more than the engine does.** Connecting memory or skills writes
`allow: ['<provider>.*']` into your profile, which includes the write half. Default-deny is true of
the policy engine — nothing is reachable without a rule — and not of the file `connect` writes for
you. Narrowing it is one `deny` line or a second profile.

**`lanes link deploy` also writes an allow rule, and not only for the profile you named.** A profile
written before the `setup` surface existed serves none of it, silently — the capabilities are absent
from `tools/list` rather than refused — so `connect` and `deploy` add the connection row and
`allow: ['setup.*']` to any profile missing both. `deploy` does this for every profile it is about to
upload, which without `--profile` is the whole workspace, because a profile it sends is a profile the
endpoint will serve. Both commands print what they added. The surface is read-only (ADR-019) and
`deny: ['setup.*']` stops the repair and keeps it off; deleting the two lines does not, because the
next `connect` or `deploy` puts them back.

**Vault reads deserve stricter treatment than other reads.** Tools only, never resources — resources
are listable and cacheable, which is wrong for secrets — plus per-item policy through the capability
name and aggressive audit redaction. A stored value is recorded as `<withheld>`, not as a type marker,
because a secret's length is a real disclosure.

**A vault write cannot hand itself a read.** Item capabilities are read when the runtime is built, so
an item stored by `vault.put` is unreadable until the next start. Granting access to a new secret is a
deliberate act by the operator between two runs. ADR-014 gave the registry a `replace` for skills;
pointing it at the vault would turn this property into a race, and the tests say so.
