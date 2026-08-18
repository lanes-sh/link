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
| What | refresh tokens, OAuth app secrets, the profile token | the owner's own passwords, API keys |
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
| `deployed.config-not-self-writable` | ENFORCED (deployed target) | the revision's `objectAdmin` grant is conditioned on the prefixes it owns, so `profiles/`, `providers/` and `lanes-link.yaml` are readable and not writable. Enforced by the platform; `src/deployments/grants.test.ts` asserts the keys the endpoint writes fall inside the condition and the config paths fall outside. This replaces the read-only image that carried the guarantee before [ADR-023](adr/023-the-workspace-is-not-in-the-image.md) |
| `audit.append-only` | ENFORCED | the store interface has no update or delete |
| `audit.tamper-evident` | ENFORCED **for edits and mid-run removals** | records are hash-chained per run; `lanes link audit verify`. Truncating a run killed mid-write, or deleting a run whole, is not detectable — see [ADR-020](adr/020-the-log-is-objects.md) |
| `audit.redaction` | ENFORCED | provider redaction tests, including on denials |
| `discovery.policy-filtered` | ENFORCED | `tools/list` and `server/discover`, over the wire |
| `setup.reports-only-reachable` | ENFORCED | `src/server/setup-surface.test.ts`; a denied connection reads as one never made |
| `setup.no-credential-presence` | ENFORCED | `missingRequirements` is CLI-only; the surface reports requirements, not what is stored |
| `transport.stateless` | ENFORCED | restart-mid-session test |
| `credentials.encrypted-at-rest` | ENFORCED (file adapter) | nothing readable on disk; tamper detection |
| `profile.isolated` | ENFORCED | cross-profile token, state, and audit tests |
| `limits.per-profile` | ENFORCED per instance | rate limit tests |
| `audit.every-invocation` | ENFORCED **with one documented exception** | see below |
| `credentials.plaintext-in-use` | NOT-GUARANTEED | inherent |
| `provider.sandboxed` | NOT-GUARANTEED | provider code is trusted |
| `egress.controlled` | NOT-GUARANTEED | follows from the above |
| `policy.approval_required` | RESERVED | the model carries the state; no engine, and it fails closed |
| `delegation.external-clients` | RESERVED | the principal parameter; nothing more |

### The documented exception to `audit.every-invocation`

Every call that reaches dispatch is audited, allowed or denied. A call naming a **capability that
policy filtering hid** is also audited, via `Dispatcher.recordRefusal`.

**Not audited:** a call to an advertised tool whose *arguments* fail schema validation — including a
`connection` value outside the advertised enum. The protocol layer rejects it before dispatch runs.
The caller gets a clear error naming the permitted options, and nothing is invoked, but no audit row
is written.

This was found by end-to-end verification rather than reasoned about in advance, and it is recorded
here rather than papered over. Closing it would mean either dropping the enum from the tool schema —
which is what makes connections undiscoverable in the first place — or parsing the request body at
the edge. Neither trade is currently worth it.

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

**A Google Cloud project left in "Testing" publishing status expires refresh tokens after seven
days.** That is a policy setting, not a bug, but it presents as an authentication failure on a
weekly schedule — so `invalid_grant` is detected specifically and the error names the cause. See
[`setup/google.md`](setup/google.md).

## Known limitations (M1)

- **Bearer tokens are bearer authorization.** Anyone holding the profile token is the principal.
  Tokens are not bound to a device. Revocation means rotating the token and reconciling.
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
