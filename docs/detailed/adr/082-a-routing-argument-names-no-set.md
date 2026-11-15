# ADR-082: A routing argument names no set, because the set changes without the list

**Status:** accepted · **Completes** [ADR-075](075-the-list-a-client-caches-must-stop-changing.md) ·
**Amends** [ADR-001](001-connection-routing.md)'s "the enum is the discovery filter" and
[ADR-079](079-the-dashboard-credential-names-a-person.md)'s "the last enum" ·
**Follows from** [ADR-032](032-a-stateless-endpoint-does-not-announce-its-tools.md)
**Date:** 2026-11-16

## Context

A profile was added to a workspace whose endpoint a client was already talking to. The endpoint
opened it and served it: the container logged the new generation on reload, with no `not serving`
line, and `/reload` returned the profile in the set that actually opened. The client could not
name it. Deleting the connector and adding it again fixed it.

Two things about the failure are worth having written down, because both were guessed wrong first:

- **Reconnecting the transport is not enough.** A client can reconnect, report itself reconnected,
  and still hold the old list. Whether the stale copy lives in the session or a layer above it is
  not observable from here, and does not matter: the list has to be *re-fetched*, and reconnecting
  does not do that.
- **The refusal never reaches the endpoint.** A client validating against its cached schema refuses
  the call locally — `Invalid option: expected one of …` — so there is no server-side mitigation to
  find. Whatever the fix is, it is a change to the schema.

The cause is that `profile` and `connection` are per-principal enums, built at list time and baked
into every tool's `inputSchema`. Four sites built them: the two registration paths in
`server/mcp/tools.ts`, and the two stable-name surface tools in `server/mcp/search.ts`. Nothing
else about the surface moved — a profile holding only the owner layer adds no new tool *names*, so
the list a client already had was byte-identical apart from those enums.

Nothing on this end can fix that while the enum is in the schema. `listChanged: false` and
`ttlMs: 0` are both already sent and already pinned (`server/caching.test.ts`), which is the whole
of what the protocol offers, and clients ignore them. A stateless endpoint cannot push
`notifications/tools/list_changed`: ADR-002 chose streamable HTTP without sessions and the server
instance is discarded once the response is written. ADR-032 declined the notification for want of a
stream; ADR-075 restated it after the 2026-07-28 revision added one, because this endpoint still
does not hold it.

So the question is what an enum in a list nothing can refresh is actually worth. The answer is the
decision:

> **It refuses exactly one call: the correct one.** Every value in the cached enum is still valid,
> because adding a profile removes none and connecting an account removes none. The only input the
> constraint rejects is the input naming what has appeared since. A constraint whose entire
> discriminating power is against newly-correct values is not a constraint.

The shape this lands on is already in the tree and has been since prompts existed:
`server/mcp/prompts.ts` takes `profile` and `connection` as optional strings with the candidates in
the description, resolved by `resolveScope`, and nothing has gone wrong there.

## Decision

**`profile` and `connection` are plain strings on every tool, with the candidates in the
description and the refusal in the handler.**

| Site | Was | Is |
|---|---|---|
| `tools.ts` `registerLocalTool` | `z.enum(profiles)`, `z.enum(connections)` | `z.string().min(1)` with a described candidate list |
| `tools.ts` `routingProperties` (discovered) | `{ type: 'string', enum: [...] }` | `{ type: 'string', minLength: 1, description }` |
| `search.ts` `lanes_tools_search` | `z.enum(profiles).optional()` | `z.string().optional()` |
| `search.ts` `lanes_tools_call` | `z.enum(profiles)` | `z.string().min(1)` |

`required` does not change, and `minLength` is added rather than dropped. That is the whole of the
distinction being drawn: a constraint that cannot go stale is not the kind this removed.

`connection` gets the same treatment as `profile`, because the identical bug fires on
`lanes link connect` and fires far more often. An account connected after a client cached its list
was equally unnameable, and the issue that prompted this only found the rarer half.

### The enum was never the gate

`mergeCapabilities` filters on `mayReach` before it looks at a single capability, and on
`allowedConnections` per candidate account — which calls the same `evaluate` the dispatcher does,
which is the half of ADR-001's claim that survives untouched. `Dispatcher.invoke` asks `mayReach`
first: who, before what. A capability no connection permits is not registered at all.

And the enums never expressed the one constraint they looked like they expressed. Both were a union
deduplicated **across** profiles, so a valid profile paired with another profile's account has
always validated, and has always been refused by hand in three places — `tools.ts`, `search.ts`
and `routing.ts`. ADR-001 called the enum "the discovery filter". The filter is
`allowedConnections`; the enum was its *rendering*, and a third copy of an answer two layers
already held — the only copy pinned to a moment.

The rendering moves to the description, where it says strictly more than the enum could: accounts
grouped **by profile**, with the account beside each opaque id (ADR-073). A flat union could not
say that, which is why the pairing refusal had to exist in the first place.

### Non-disclosure rests on a refusal that cannot be told apart

This is the half that amends ADR-079's "The last enum", and the amendment is narrower than it
looks: the filter does not disappear, it stops being expressed twice.

`options.profiles` holds every profile the endpoint serves. `entry.reachable` is `mayReach`-filtered.
So a name that does not exist fails the first test, a name the caller is not a member of fails the
second, and both arrive at one sentence — differing only in the name the caller themself supplied
and in their own `Available:` list, which they already held. That is ADR-079's rule for `/data`,
said again for tools: it "answers a profile the caller is not on with the same `404` it gives an
unknown path", because "a distinguishable refusal would confirm the profile is there".

What a caller can now do is *guess*. They could always guess; the enum only told them which guesses
were pointless. What they cannot do is learn anything from a guess, and that is the property, held
by a test that normalises the supplied name out of both refusals and compares what is left.

Two consequences of moving the property here, both now asserted:

- **`makeHandler`'s cross-profile refusal was unreachable for a typed tool.** Its enum was exactly
  `[...entry.reachable.keys()]`, so nothing that validated could miss `reachable`. The branch was
  dead and is now load-bearing.
- **A member of nothing was served `{"not":{}}`.** `z.enum([])` publishes as a property no value
  satisfies, carrying a description inviting its use, and refuses with a dangling `expected one of`.
  They still reach nothing; they are now told so by a refusal rather than by an unsatisfiable
  schema a strict client-side validator can reject outright.

### Two leaks closed on the way past

Both are the shape ADR-079 named, and neither was anywhere ADR-079 looked. The useful lesson is the
general one: **`mergeCapabilities` filters what it returns, and three separate places read the
profile map sitting beside it.**

- `buildMcpServer` built the server `title` — `Lanes Link — <profiles>` — from the unfiltered map,
  and `initialize` serves it to every caller. A member of one profile was told the name of every
  profile the workspace holds.
- `accountsByProfile` read the whole map too, and `lanes_tools_search` hands the result to a caller
  twice: the `Reachable from here` prose and the declared `reachable` output field.

Filtered inside `accountsByProfile` rather than at its one leaking call site, because the claim
`server/mcp/index.ts` makes for `visibility.ts` is that it is the only place a discovery leak can
come from, and a filter at the call site leaves the trap set for the next caller.

## This is not a weakening of default deny

`CONTRIBUTING.md` pushes back on "registering a capability that is then refused on call rather than
filtering it out of discovery". This is not that, and the distinction is the decision.

**No capability's registration changed.** `mergeCapabilities` still drops a capability the principal
cannot reach on any connection, still drops a profile `mayReach` excludes, and `advertisedTools`
still decides which survivors get a typed tool. `tools/list` holds exactly what it held. What
widened is the declared domain of one injected **argument** of a tool that was already there, from
"the values that were true at registration" to "a string" — and every value outside the old enum is
refused on exactly the checks that refused it before, before anything is dispatched, audited, or
spent upstream.

The test is whether a caller can reach something they could not. They cannot, and nothing in the
authorization path was touched.

## What this costs

- **An honest client no longer learns that a value is invalid before sending it.** A typo a
  locally-validating client would have caught now costs a round trip and a text refusal. It costs
  nothing further: the refusal is returned before `dispatcher.invoke`, so there is no audit row, no
  upstream call, and no rate-limit unit spent against a vendor.
- **Autocomplete and argument pickers lose their candidate list for these two arguments**, and get
  a described list in the same tool instead.
- **About 95 bytes per tool on the wire**, netting the removed enum arrays against the longer
  descriptions — roughly 3% on a large list. No budget in the repository measures it: all three in
  `cli/tools.test.ts` measure what `discover()` returns, which is before these are injected. Said
  here because nothing will fail if it grows.
- **This change itself needs one re-fetch.** Enum to string is a schema change, so every connected
  client picks up the new shape once and only then stops being moved by profiles and accounts. It
  also does not retire re-fetching in general: a release that renames a provider or a tool id still
  moves the list, which is ADR-066.

## Alternatives rejected

- **Send `notifications/tools/list_changed`.** There is no stream to send it on and no instance to
  send it from (ADR-002, ADR-032, ADR-075). Restated because it is the first thing a reader
  proposes.
- **Lean on `ttlMs: 0`.** Already sent, already pinned, already ignored. The field is a request, not
  a mechanism.
- **A generic description pointing at `lanes_setup_overview` or `lanes_tools_search`.** Staler-proof
  and worse: the per-profile account tree is the only thing that tells one opaque id from another
  (ADR-073), and sending a caller somewhere else for it costs the round trip this surface exists to
  avoid. A caller reading an argument description is composing a call, not exploring.
- **JSON Schema `examples`.** It recreates the "this set is closed" inference with no constraint
  behind it, cannot be expressed identically on both registration paths, and would have to name
  one profile — which the served instructions and `guide.ts` both forbid in words: "Do not default
  to whichever is listed first."
- **Only the two surface tools.** Consistent with how ADR-075 already answers a newly connected
  account, and the smallest change. Rejected because it leaves the natural path broken: a model
  would have to be taught to route around a typed tool whose name is sitting in its list.

## What this does not do

It does not send a notification, vary the surface by client, or change what is advertised. It does
not make a stale description true — the candidate list is still a snapshot, and the description now
says so.

It does not extend the stale-generation self-heal. `Generation.knows` probes a level down for
`lanes_tools_call` and `lanes_tools_search`, but for a typed tool it asks only whether the *name* is
advertised, so a typed call naming a profile the running generation has not opened yet still refuses
without triggering a reload. That is a different failure from this one — here the endpoint had
already opened the profile — and it is left alone.
