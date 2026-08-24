# ADR-033: Where a vendor will not register us as a client, the operator's own token is the credential

**Status:** accepted · **Complements** [ADR-028](028-a-hosted-oauth-client-is-the-default.md)

## Context

Proxying a vendor's own MCP server is the cheapest integration this project has. Notion and Linear
are fifteen lines of data each: the vendor wrote the integration, the vendor maintains it, and what
we add in front is per-capability policy, audit with redaction, and profile isolation. Both cost
nothing to *connect*, too, because both support Dynamic Client Registration — Lanes Link registers
itself with their authorization server at connect time and the operator does nothing at all.

GitHub and Slack run official MCP servers and neither supports DCR. Slack's documentation says so
in as many words: *"We do not support SSE-based connections or Dynamic Client Registration at this
time."* GitHub's position is that it is coming and is not here.

That should leave the fallback every other provider uses. It does not, and the reasons are worth
recording, because each looks like something we could fix and is not:

- **A client of the operator's own** (`registration: manual`, what `--own-client` does for Google).
  Slack requires redirect URIs to be **HTTPS**, and `connect` listens on `http://127.0.0.1` on a
  port the kernel picks per run — there is no proxy, tunnel, or flag that makes a loopback listener
  HTTPS. GitHub permits `http://127.0.0.1` but matches the callback URL exactly, port included, and
  there is no fixed port to register.
- **A broker** — the answer ADR-028 built, where somebody runs a client and performs the exchange.
  `defineProvider` refuses one on an `mcp` connector, and has since that ADR: an MCP provider hands
  the exchange to the SDK, which posts to the token endpoint with whatever `clientInformation()`
  returned, and there is no seam to route that through a broker without reimplementing the SDK's
  auth path. Building that seam is a large change to buy a browser round trip in place of a paste.
- **Waiting.** Real, and cheap, and it is what "not yet supported" invites. It also means the two
  services an agent working in a repository most obviously wants are absent for as long as two
  vendors take.

Both vendors do issue a credential for exactly this case, and both document sending it as
`Authorization: Bearer` — GitHub a fine-grained personal access token, Slack the user token an
installed app mints.

## Decision

**An `mcp` connector may authenticate with a token the operator pasted.** `auth: {kind: bearer}`
already described that shape and `ensureStaticCredential` already collected it — the path iCloud's
app-specific password takes. What did not work was sending it, and that is what this decision
changed.

Four call sites asked `CredentialOAuthProvider` for the token, which for a bearer manifest returns
`null` rather than raising: its tokens ref is `<provider>/<connection>`, byte-identical to the ref a
pasted token derives, so it read the token, failed to parse it as a JSON blob, and returned
`undefined` by design. The connection then went upstream with no `Authorization` header at all — no
error, an empty tool list, and nothing to read that said why. `connectivity/auth/token.ts` is the
single answer now, and `#cli` no longer reaches into the OAuth provider to ask which token a
manifest authenticates with.

**An `mcp` connector's auth is exactly `none`, `oauth`, or `bearer`, and nothing else**, refused at
definition. The transport sends one header and reads nothing else from the resolved credential, so
`api_key`, `header`, and `basic` would each validate and then be dropped in silence — the same
failure this decision exists to fix, left with a second door open. `bearer` may not rename its
header here either, for the same reason.

**`connector.headers` comes with it.** An `http` connector narrows what it exposes with
`operations`, because it reads a document listing everything the API can do. An MCP server decides
that itself and answers `tools/list` with whatever it chose, so where a vendor makes the choice
configurable it is a header they define — GitHub's `X-MCP-Toolsets` being the case in hand.
`Authorization` is refused there too: with both set, which one is sent would be merge order.

## Consequences

**Two guarantees are weaker for these providers, and `security.md` says so.**

The credential is long-lived and *is* persisted. For an OAuth provider the stored secret is a
refresh token — a means of obtaining a credential, exchanged on every use, with the access token
never leaving memory. Here the stored value is the credential itself. Rotation is manual:
`connect --replace`, after revoking upstream.

There is no scope-disclosure gate. `confirmScopes` shows an operator what is about to be granted and
refuses to proceed when the set has widened without being agreed. Nothing equivalent is possible
for a pasted token: what it can do is chosen in the vendor's console, and this endpoint has no way
to read it back. The policy layer still bounds what an agent may call; the credential's own reach is
the operator's to bound, at the vendor, when they generate it. Both setup pages say so at the point
the token is created.

**Redaction cannot be checked.** `cli/tools.test.ts` verifies that every key in a `redact` block
names a real argument, and can do so only for `http` providers — a proxied server's capabilities are
discovered at connect time, so there is no local schema to check against. GitHub's and Slack's
blocks were written from the tool schemas those servers publish rather than guessed, but a rename
upstream fails the way that test exists to prevent: silently, with the value withheld and the log
reading exactly as it does when redaction is working. `doctor`'s capability drift report is the
signal to re-read them.

**Slack costs a console visit and always will.** Creating a Slack app is the only way to obtain a
user token, so `docs/connect.md` no longer claims no provider asks you to register anything. This is
the first time that sentence has needed an exception, and pretending otherwise would be worse than
the exception.

**What this is not.** It is not a retreat from ADR-028. A hosted client remains the default wherever
one can be used, and if either vendor ships DCR the change is one field in one manifest —
`registration: dynamic` — because auth is orthogonal to connectivity here. The `bearer` path stays
correct for every other MCP server behind an API key, which is the larger part of what this bought.
