# ADR-075: The list a client caches must stop changing

**Status:** accepted · **Completes** [ADR-032](032-a-stateless-endpoint-does-not-announce-its-tools.md) ·
**Narrows** [ADR-001](001-connection-routing.md)'s "one tool per capability" to "one tool per
capability, and one way in that is not a tool"

## Context

Every capability a principal can reach is registered as its own MCP tool, with its full input
schema, on every `tools/list`. That is ADR-001 and ADR-006 working as designed, and it has two
costs that have grown past the point where they can be left unrecorded.

**The list is large, and most of it is not ours to shrink.** Measured from the vendored specs, as
`registerDiscoveredTool` actually registers them — `title`, `description`, `inputSchema`, which is
what travels and not what the capability object weighs:

| | tools | on the wire |
|---|---|---|
| every `http` provider | 144 | 428 KB |
| gmail, drive, calendar, sheets, google\_tasks, docs, contacts | 65 | 294 KB |
| drive alone | 9 | 127 KB |

At four bytes to a token that middle row is about 75K tokens, spent before the agent has read the
request. And it is the *controllable* part: 77 of roughly 105 providers declare
`connector.kind: 'mcp'`, and their schemas are the upstream server's verbatim — deliberately, since
`registerDiscoveredTool` spreads rather than rebuilds them because vendors put `$defs` beside
`properties` and a rebuild leaves a schema that cannot resolve itself. Notion, Linear, Slack, GitHub
and Atlassian are all in that set. The ceiling on an eager surface is therefore set by other
people's schema choices, and no amount of care here moves it.

**The list changes, and not every client asks again.** ADR-032 established that a stateless
endpoint cannot promise `listChanged`, declared it `false` so a client has no reason to trust a
cache, and said plainly that nothing here can *make* a client re-read. That remains true, and the
observed consequence is the one recorded in issue #162: connecting a provider a profile had none of
changes what `tools/list` returns; a client that pinned its list at registration serves the old one;
in one hosted client the connector has to be deleted and re-added before the new provider is
reachable at all.

ADR-001 already narrows the window — connection identity is an argument, so a second mailbox, a
fifth account, a renamed connection all leave the list untouched. The list moves only when a
provider arrives that the profile had none of. That is a small window and it is the window every
first use of a new provider falls into.

### What the industry settled while this sat open

Progressive disclosure of tools is real, it works, and it is a **client-side** mechanism. The Claude
Developer Platform's Tool Search Tool defers definitions above roughly 10K tokens and loads three to
five on demand: about 72K tokens of definitions becomes about 500 plus 3K, an 85% reduction. The
number that matters here is not the saving but the accuracy: tool selection *improved*, 79.5% to
88.1% on one model's MCP evaluations and 49% to 74% on an older one. A discovery step is not a tax on
selection. It is published guidance to defer above ten tools or 10K tokens, and not to bother below
that.

Two things follow, and they point in opposite directions.

The first is that our best clients already solve the size problem without us, and better than we
could. Their index is local, so a search costs no round trip; deferred definitions never enter the
initial prompt, so prompt caching survives; and the full typed schema is in front of the model at the
moment it composes arguments. This endpoint cannot match that last property — ADR-002 chose stateless
streamable HTTP, so a discovery call is a network round trip that rebuilds the whole server. Removing
the typed tools would make the clients that behave well worse in order to help the clients that do
not.

The second is that a client-side mechanism is only as good as the client. It does nothing for a
client that caches a tool list at registration and never asks again, and that client is the one
issue #162 is about.

### What the protocol added, and what it did not

The 2026-07-28 revision has no tool search, no tool filtering, and no deferred schema. The proposal
for one — a `searchTools` meta-tool per library — is SEP #1888, a draft opened in November 2025 with
no sponsor and no pull request. There is nothing to implement against, so anything built here is
ours alone, and a bespoke discovery surface is one the clients that defer well can no longer defer.

What it did add is cache control, and it is aimed squarely at the staleness half. `tools/list`
results now carry `ttlMs` and `cacheScope` (SEP-2549), and a server **MUST** include them. `ttlMs: 0`
means "immediately stale; the client MAY re-fetch every time the result is needed" — which is what
ADR-032 was saying by declaring `listChanged: false`, now said in a field rather than by implication.
`@modelcontextprotocol/server` 2.0.0 fills both at its encode seam with the conservative defaults
`{ ttlMs: 0, cacheScope: 'private' }`, and nothing in `src/` configures `cacheHints`. So the standard
lever is already in force, already correct, and resting on a third-party default.

The revision also settles a question that would otherwise have been open. The tool set **MUST NOT**
"vary per-connection or as a side effect of other requests on the connection", but **MAY** "vary by
the authorization presented on the request". Filtering per principal — `mergeCapabilities` over
`mayReach` and `allowedConnections` — is exactly the blessed case. Serving a different tool set to a
different client is exactly the forbidden one.

## Decision

**One typed tool per capability stays, and two tools are added that are always there and never
change name.**

```
lanes_tools_search(query, limit?)                              → matches, with their input schemas
lanes_tools_call(profile, connection, capability, arguments)    → invokes any of them
```

`search` returns the full `inputSchema` for its strongest matches and name-and-description for the
tail, because a search that returns only names is the version of this that loses the accuracy the
published evaluations attribute to it: the gain comes from the model seeing a real schema before it
composes arguments, not from the list being shorter. The tail exists because a query matching ten
Drive write tools would otherwise return a quarter of a megabyte in one tool result. An exact
capability id as the query returns that one capability with its schema.

`call` sits on the path that already exists and is the only path. `Dispatcher.invoke` takes
`capabilityId` as a string and resolves it through `registry.findCapability`; the per-tool handler is
a thin closure over one hard-coded id. So this widens nothing: the same principal, the same
`allowedConnections`, the same policy, the same cross-profile refusal, and the same audit row. And it
cannot reach the control plane by construction, because control-plane operations are never registered
and `findCapability` resolves only what is (ADR-007, ADR-051).

**The search says which way in to use.** Issue #162 called this shape "two ways to do one thing on
one surface — the duplication this codebase refuses elsewhere — and a model seeing both will
sometimes pick the wrong one". That objection is answered by making the search the authority on
routing rather than a peer of it: every result names the typed tool to prefer and says
`lanes_tools_call` is for when the caller's own list does not have it. The model can see its tool
list and the server cannot — a stateless endpoint has no idea what a client cached — so the decision
belongs to the party that holds the information. What is on the surface is one way in with a
fallback, not two ways in.

**Nothing is removed, and no threshold is introduced.** Two small tools cost a client almost nothing,
so they are unconditional. Whether typed tools should ever *stop* being advertised above some size is
a different decision, it needs a measurement of this surface against them that no published
evaluation can supply, and it is not taken here.

## Consequences

**A newly connected provider is reachable without the client asking again.** `lanes_tools_search`
and `lanes_tools_call` are in every list any client has ever fetched from this endpoint, including
the first one, which under ADR-032's own worst case held two setup tools and nothing else. So the
answer to "connect Notion, then use Notion" stops being "start a new session" or "delete the
connector" and becomes a search.

**ADR-032's trade is unchanged and its reasoning is now carried by a field.** `listChanged: false`
still says what it said. `ttlMs: 0` says it normatively, and the SDK already sends it. This ADR adds
the test that pins both that and `cacheScope: 'private'`, because a per-principal tool list is
deliberately identity-revealing — ADR-060 keeps a profile a member is not on out of the enum so they
"never learn it exists" — and `cacheScope: 'public'` would let one token's list be served from a
shared cache to another. That is a correctness property of the surface, not a caching preference, and
it should not rest on someone else's default.

**The whole advertised payload gets a budget.** `src/cli/tools.test.ts` caps a single tool at 64 KB
and a single provider's surface at 192 KB. Nothing capped the total a client is handed, which is the
number that actually decides whether a hosted client accepts the response and whether a client hides
the tools behind a search of its own. It is seeded at what is measured today, as a ratchet with the
same headroom the other two carry.

**Tool names and descriptions become the search index, and are written that way.** This follows from
deferral being client-side: a client that defers ranks on name and description, so those are no
longer only documentation. `title` was `undefined` on all 144 discovered tools — the field an index
most wants was empty — and vendor summaries carry no vendor noun, so Gmail's read "Lists the drafts
in the user's mailbox" and a search for *email* matched nothing in Gmail. `hints` on the manifest is
the existing mechanism for the sentence a vendor did not write, and it applies to `mcp` providers as
well as vendored ones.

**A provider can be declared into a profile before it is connected.** The advertised list is built
from grant rows and never consults credential status, and granted-but-unauthorized is already a
first-class state that does not block startup and already fails a call with an actionable message.
What was missing was a way to reach it deliberately. With one, an operator can make the list stable
*before* a client is registered, and the later `connect` fills in a credential without moving the
list at all. That is the cheapest available answer to #162 and it is available because of ADR-058:
the grant row is the grant, and it does not know whether a credential exists.

## What this does not do

**It does not vary the surface by client.** The revision forbids it, and `clientLabel` is
self-reported and documented in two places as recorded for audit and never consulted to decide what
a caller may do. A dispatch pair served only to the clients that need it would be both
non-conformant and an authorization decision made on an unauthenticated string.

**It does not add a per-connection opt-in.** A `lazy: true` on a grant row would be a second surface
shape with no way for a model to know which one it is looking at, two dispatch paths to keep tested,
and a client-visible difference whose effect the operator cannot see. It is also the wrong
granularity: what makes a surface too large is the endpoint's total, which is a property of the
profile and not of one row in it.

**It does not retire `makeOpaque`.** Making schemas load on demand does not make a large schema
small. `sheets.spreadsheets.batchUpdate` inlines to 2,469 KB and `spreadsheets.create` to 1,133 KB
against a 64 KB budget; a deferred load of either is the same number of bytes, and the Anthropic API
rejects the whole `tools` array over one that will not fit. The per-tool budget is a cap under any
exposition strategy, and the `opaque` list stays the remedy.

**It does not advertise tools for providers that are not connected.** For the 77 `mcp` providers it
is not possible: their capabilities are discovered by opening an authenticated connection to the
upstream server and calling `listTools()`, so with no credential there is no list to advertise. For
the vendored ones it is possible and worse — the whole 428 KB, for accounts the profile does not
have. The declared-but-unauthorized state above is the useful part of the idea, and it is scoped to
what an operator has actually chosen.

**It does not send a notification on the modern leg.** ADR-032 declined this for want of a stream and
noted that the 2026-07-28 revision has one. It does: `subscriptions/listen`, opted into per
notification type. The conclusion is unchanged and the reason is better — the protocol has a stream
and this endpoint does not hold one, because ADR-002 chose stateless streamable HTTP and the server
instance is discarded once the response is written.

**It does not decide that typed tools have a size limit.** Only that if they ever do, the number
comes from measuring this surface against them.
