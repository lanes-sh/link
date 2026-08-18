# ADR-019: Describing setup is not performing it

**Status:** accepted

A `setup` provider now appears on the MCP surface, and a `lanes link connect` can now be
run by something that is not a person. Both look like the wall in [ADR-007] moving. Neither
is, and this records why — so the next reader does not have to reconstruct the argument, and
so anyone who does want to move it knows what they are arguing against.

## What has not changed

Nothing reachable over MCP writes configuration, stores a credential, runs a sign-in, mints
or reads a token, or changes what is permitted. `src/dispatch/control-plane.test.ts` still
runs its seven patterns over every registered capability id, and the `setup` provider is
registered into the fixture it checks.

## Why a read-only setup surface is on the other side of the line

ADR-007's unifying sentence is that each excluded operation *authorises future agent
behaviour*, so the decision has to originate outside the agent. That is a rule about
authorisation, not about information. Describing what connecting Notion would involve
authorises nothing: the scopes, the console steps, and the command are all shipped code,
readable in this repository by anyone who has it.

Drawing the line at information instead would also forbid `tools/list`, which already tells
a caller exactly what it may reach — and `GET /health`, which names every profile without
authentication at all.

## What the surface may report, and what it may not

Two capabilities, both tools, no write bundle: `setup.overview` and `setup.provider`. The
absence of a third is asserted in `src/providers/setup/provider.test.ts` rather than left to
review.

**Only what the caller may already reach.** `reachable()` is built in `src/cli/runtime/open.ts`
and filtered by `allowedConnections` — the same function the dispatcher enforces with and
`mergeCapabilities` builds the `connection` enum from. Computing visibility a second way is
how discovery and enforcement drift, and a leak in discovery is still a leak.

ADR-007 also says probing must not be an oracle: an unknown capability and a denied one are
refused identically. A surface that describes what is configured could undo that in one call,
so a connection hidden by `deny` must read *exactly* like one that was never made.
`src/server/setup-surface.test.ts` asserts that character for character over real HTTP.

**Requires, never satisfied.** The surface says what a provider will ask for. Whether the
value is already in the credential store needs the store, and only `lanes link` asks —
`missingRequirements` stays in the CLI and this provider never calls it. Without that split,
"is Gmail set up?" becomes a credential-store oracle.

**Labels, never credential references.** The command it emits *asks* for each value, so the
owner never needs to know where one is filed; a ref is a key name of ours rather than
anything they can act on. The `printf … | lanes link secrets set …` spelling belongs to
`lanes link setup plan`, whose reader has a shell and is scripting.

**One genuinely new disclosure: the account label.** `setup.overview` names
`you@example.com` against a connection, which nothing on the MCP surface did before. This is
deliberate. A caller holding a grant on `gmail.main` can already read that mailbox, which
discloses the address on the first message; withholding the label while serving the mailbox
would be theatre. And the label is the entire point — an agent saying *"you already have
you@example.com connected, Notion is not"* is the deliverable.

Everything else it reports is either shipped code or already visible through `tools/list`,
the injected `profile` and `connection` enums, and `/health`.

## Tools, not resources

ADR-006 says decide per capability. `setup.overview` is superficially resource-shaped —
read-oriented, no arguments — and is a tool anyway. Resources are registered per (profile,
connection) and surfaced by clients as user-attachable context, while the point here is an
agent reaching for it unprompted when someone says "set up Notion". Resources are also
cacheable, which would promote the staleness below into a protocol feature.

## The naming trap

`FORBIDDEN_CAPABILITY_PATTERNS` are unanchored. `setup.overview` and `setup.provider` are
clean; the names anybody would reach for first are not:

```
TRIP  setup.connection_steps    /(^|[._])(connect|authorize|oauth)/i   (".connect" inside ".connection_")
TRIP  setup.credentials_needed  /credential|secret|password/i
TRIP  setup.config_path         /(^|[._])config/i
TRIP  setup.policy_rules        /policy/i
TRIP  setup.allowed             /(^|[._])(grant|revoke|allow|deny)/i
TRIP  setup.token_hint          /(^|[._])(token|bearer)/i
```

That is the rule being blunt rather than wrong — it cannot read intent, and a rule that
tried to would be a rule with opinions. Renaming either capability is a change to whether the
suite passes. The table is itself a test.

## Why the CLI became drivable instead of the surface becoming writable

The ergonomic problem was real: setting anything up meant leaving the agent and typing. The
two ways to solve it were to let the endpoint perform setup, or to let something else drive
the command that already does. The second keeps the endpoint free of an administrative
surface, which is the sentence ADR-007 ends on.

`assertInteractive` threw on any non-TTY, so no agent could run `connect` at all. It now
takes a `Prompter`, and a non-interactive run resolves every declared value from the
credential store up front or refuses with the exact `lanes link secrets set` line. It reads
no credential from a flag, an environment variable, or a file: `secrets set` already refuses
argv for secrets and says why, and a value typed by an agent lands in a transcript too.

The resulting boundary is real, and worth stating plainly rather than engineering around:

| Provider auth | Agent drives it end to end? |
| --- | --- |
| `none` | yes |
| `header` / `api_key` / `bearer` / `basic` | yes — store the value, then `connect --non-interactive` |
| `oauth` | **no** — it emits the one command for the person who owns the browser |

OAuth is refused by the preflight rather than attempted. `connect` would open a browser and
block on a loopback listener for five minutes; an agent's shell times out first, taking the
listener with it, and leaves no token and no explanation.

## What this does not do

**`--accept-broad-scopes` is a document, not a control.** Nothing stops a client passing it.
The skill says not to, the flag is verbose enough that repeating it is deliberate, and it
lands in the shell history of whoever typed it. The browser consent screen is still ahead of
it. Treat it as the earlier, clearer checkpoint rather than the only one.

**A new connection is not served until the endpoint restarts.** `runtime.config` and the
policy document are read once at startup, and re-opening a runtime mid-flight would change
what policy is evaluated against between two calls — `ProviderRegistry.replace` says in its
own docstring that it is not a general hot-reload facility. So `setup.overview` says so
rather than pretending otherwise. A staleness flag on the existing 2s budget would be an
honest improvement; a live reload wants its own decision, because "a running instance never
mutates its own configuration" is adjacent enough to matter.

**The shell-less ceiling is accepted.** For a client with no shell the loop ends with a
person pasting one line. Closing that would require the endpoint to act on it, which is
exactly what ADR-007 forbids.

[ADR-025] reopens the OAuth row of that table for the deployed case specifically, and is
proposed rather than accepted. The reason recorded above is a loopback listener outliving an
agent's shell — a Cloud Run service has neither, so the mechanical objection does not transfer.
The authorisation objection does, and that is what it has to answer.

[ADR-007]: ./007-control-plane-exclusions.md
[ADR-025]: ./025-connecting-an-account-from-a-deployed-endpoint.md
