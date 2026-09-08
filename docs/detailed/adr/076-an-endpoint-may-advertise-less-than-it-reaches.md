# ADR-076: An endpoint may advertise less than it reaches

**Status:** accepted · **Amends** [ADR-075](075-the-list-a-client-caches-must-stop-changing.md) by
taking the decision it deferred · **Depends on** [ADR-032](032-a-stateless-endpoint-does-not-announce-its-tools.md)

## Context

ADR-075 built `lanes_tools_search` and `lanes_tools_call`, measured the eager surface at 428 KB for
the `http` providers alone, and then declined to shrink anything:

> Nothing is removed, and no threshold is introduced. Two small tools cost a client almost nothing,
> so they are unconditional. Whether typed tools should ever *stop* being advertised above some size
> is a different decision, it needs a measurement of this surface against them that no published
> evaluation can supply, and it is not taken here.

And, in what it does not do:

> It does not decide that typed tools have a size limit. Only that if they ever do, the number comes
> from measuring this surface against them.

This ADR takes that decision. It is an amendment rather than a reversal: every mechanism ADR-075
built is what makes this possible, and the default is unchanged.

**What the measurement now says.** Taken from a deployed endpoint serving two profiles and eleven
providers, by asking it — one `tools/list`, both ways, same generation:

| | tools | on the wire | ≈ tokens |
|---|---|---|---|
| `full` | 278 | 702 KB | 180,000 |
| `crunched` | 28 | 31 KB | 8,000 |

ADR-075's table measured 428 KB across every `http` provider. This is larger because it is the
whole surface: 77 of ~105 providers declare `connector.kind: 'mcp'` and their schemas are the
upstream server's verbatim, which is the part that ADR paragraph said no care here can move.

**180,000 tokens is not a large fraction of a context window. It is most of one**, spent before
the agent has read the request. That is the number the decision turns on, and it was not available
when ADR-075 deferred it.

The clients this is advertised to do not all accept it either:

- Hosted Claude surfaces are reported to cap the aggregate tool list at 256 across all connectors,
  keeping the alphabetically-first 256 and truncating the namespace that straddles the boundary. At
  278 that boundary falls inside one provider, which disappears with no error anywhere.
- The cost is not only the ceiling, and the ceiling is not the worst of it. ADR-075 already
  recorded the accuracy figures — 49% to 74% on one model, 79.5% to 88.1% on another — and
  attributed them to a discovery step not being a tax on selection. Those numbers cut the other way
  too: a catalogue large enough to displace the request is a catalogue the model selects from worse.
  A client that truncates at 256 at least still holds 256 usable tools; one that accepts all 278
  carries 180,000 tokens of schema into every turn.

The observed failure is the one that motivated the measurement. An agent holding this surface
reported that it could not see the endpoint's tools at all, then found them when asked a second
time — behaviour consistent with a list too large to be usefully attended to, and indistinguishable
by the operator from the endpoint being down.

## Decision

A profile may declare `surface: crunched`. It defaults to `full`, which is what every profile
written before this keeps getting and what the endpoint has always served.

Under `crunched` the endpoint registers the owner layer and the stable-name pair, and nothing else.
Every other capability stays in the merged set: reachable through `lanes_tools_call`, resolved
through the same dispatcher, evaluated against the same policy, redacted by the same rules, and
written to the same audit row. **No capability is lost. What shrinks is exposition, not authority.**

That distinction is load-bearing and is the reason this is not `grants:`. A `deny:` rule removes a
capability from the merged set, so `lanes_tools_call` cannot reach it either — which is correct for
a capability the operator does not want reachable, and wrong for one they merely do not want in
every client's context.

**The owner layer is the line, and it is not a shortlist somebody tuned.** It is the material this
endpoint holds itself rather than anybody's API, it is small, and the instructions name several of
its tools directly: an agent is told to call `lanes_setup_overview` before saying something cannot
be reached, and `lanes_entities.find` before using anyone's address. Advertising less than this
would leave those sentences pointing at tools the client cannot see.

**It is read from the primary profile only.** One endpoint serves several profiles and `tools/list`
is their union, so how much of it is advertised is a property of the endpoint rather than of a row
in it. `instance.port` already follows that rule.

## Why this is not the thing ADR-075 refused

ADR-075 refused two shapes, and this is neither.

**It is not per-client.** The mode comes from configuration the operator wrote, not from anything on
the request. `clientLabel` is still self-reported, still recorded for audit, and still never
consulted. The 2026-07-28 revision's requirement that the tool set not vary per-connection or as a
side effect of other requests is met: it varies per *deployment*, and does not move until the
operator changes it and a generation reloads.

**It is not a per-connection `lazy: true`.** ADR-075 gave three objections to that and named the
right granularity in the same breath — "what makes a surface too large is the endpoint's total,
which is a property of the profile and not of one row in it". This takes that conclusion. The three
objections are answered rather than dodged: there is one dispatch path and always was
(`dispatcher.invoke`), the model is told which shape it is looking at by a substituted paragraph in
`instructions`, and the operator sees the result in `lanes link tools`, which asks the endpoint.

**It is not a threshold.** Nothing switches itself on at a size. ADR-075's strongest argument
against removal was that clients which defer well already do it better than a server can — with a
local index, no round trip, and their prompt cache intact — and that removing typed tools would make
those clients worse to help the ones that pin a stale list. That argument is undefeated, and it is
exactly why this is opt-in and defaults to `full`. An operator whose clients handle 278 tools should
change nothing.

## Consequences

**The advertised count and the wire must agree.** `visibleToolCount` feeds `/reload`, the
`advertising` log line, and what `connect` prints, and ADR-032 exists because an operator compares
that number against what their client shows. A mode that advertised less than it counted would turn
that comparison into a false alarm. So the registration loop, the count, and the visible set consume
one function, and a test asserts the reported count equals the length of `tools/list` in both modes.

**`Generation.visible()` is no longer "everything reachable".** It is what the built server will
answer, which under `crunched` is a smaller set. This matters in the direction that fails silently:
a name left in that set but absent from the wire means a call to it is answered by the SDK and
recorded nowhere, against `audit.every-invocation`. Prompts and resources are unaffected by the mode
and stay in regardless — a skill is a prompt, and was never on the tool count.

**A `resource_link` cannot be handed back through the gateway.** `lanes_tools_call` returns text, and
ADR-075 accepted that because the caller could be told to use the typed tool instead. Under
`crunched` there is no typed tool to name, so the message says the link cannot be returned rather
than naming one the client cannot call. This is the one thing the mode genuinely costs.

**Flipping the mode changes a list clients cache.** `listChanged` is `false` (ADR-032) and nothing
here makes a client re-read. So this is a deliberate operation with the same consequence as
connecting a new provider — issue #162's consequence — and not a setting to toggle casually. It is
declared in config for that reason: an operator sets it before registering a client, which is the
same remedy ADR-075 reached for.

## What this does not do

**It does not change what `full` serves.** The mode is spread into the options object, so `full`
passes nothing and cannot be told apart from a caller that never heard of the setting. The test
suite asserts it: every existing test passes unchanged.

**It does not make the core configurable.** A `core:` list of patterns was considered and left out.
The owner layer is a principled line rather than a preference, and a knob would invite a surface
tuned per deployment — which is how two endpoints running the same version come to disagree about
what they advertise. If a deployment needs a different core, that is a decision with its own
evidence, taken then.

**It does not move `contract`.** The key is optional and additive, so every profile written before
it loads unchanged — the same reasoning as `identity`.

**It does not retire the typed tools.** They are what `full` serves, what most deployments should
keep serving, and what the search surface still describes. ADR-075's two-directions argument stands:
this is a remedy for the clients that need one, not a claim that eager exposition was a mistake.

**It does not fix cold start, and should not be mistaken for it.** The endpoint that produced the
278 also takes roughly ten seconds to bind, because it opens every profile before it listens. A
smaller list is served no sooner. That is a separate problem with a separate remedy.
