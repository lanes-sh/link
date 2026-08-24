# ADR-032: A stateless endpoint does not announce its tools

**Status:** accepted · **Completes** [ADR-029](029-connecting-is-not-deploying.md) · **Follows from** [ADR-002](002-transport-and-statelessness.md)

## Context

ADR-029 made a connected account reach a running endpoint without a redeploy. It worked: `connect`
publishes the config, `POST /reload` re-reads it, and the next `tools/list` carries the new
provider. Every part of that was observed working against a deployed revision — five connects, five
reloads, a tool list that grew from two entries to forty-two.

The client went on showing two.

The endpoint was registered as a connector before any account was connected, which is the ordering
`docs/deploy.md` describes: deploy, then connect. A first deploy necessarily publishes a profile
whose only connection is `setup.main`, because the accounts come afterwards. So the client's first
`tools/list` returned `setup_overview` and `setup_provider`, and it stored those — which is what a
client does with a tool list.

What it did not do was ask again. Refreshing the connector sent one `initialize` and stopped.

The reason was in the `initialize` answer:

```json
"capabilities": { "tools": { "listChanged": true } }
```

Nothing in this repository has ever sent `notifications/tools/list_changed`. The value was never
authored — the SDK sets it when a tool is registered:

```js
registerCapabilities({ tools: { listChanged: getCapabilities().tools?.listChanged ?? true } })
```

`listChanged` is a promise to tell the client when the list changes. ADR-002 chose stateless
streamable HTTP, so there is no stream on which to deliver such a notification and the server
instance is discarded once the response is written. The endpoint could not keep the promise, and a
client that believed it had no reason to poll.

That is the failure mode this ADR exists for, and it is worth naming precisely because nothing looks
broken from either end. The endpoint is right: it holds current config, it advertises the full list,
and it serves it correctly to anyone who asks. The client is behaving correctly too — it was told it
would be informed. The surface a person sees is stale and every component reports success.

It is also invisible. `tools/list` dispatches nothing, so ADR-020's log does not record it and
neither does anything else; the only trace of what the endpoint told a client was the byte size of a
response in the platform's request log.

## Decision

**Declare `listChanged: false`, explicitly.** `buildMcpServer` passes it in `ServerOptions`; the
SDK's `?? true` yields to an authored `false`. A client that knows the list is not announced
re-reads it, which is the behaviour a surface that changes between sessions requires.

`tools` unconditionally. Resources and prompts carry the identical default and the identical
inability, so they get the same answer — but only where the profile has some, because declaring a
capability installs its handler set, and a client that gates its list calls on what is advertised
would otherwise spend three stateless POSTs per session, each rebuilding the whole server, to be
told nothing is there.

The cost is one `tools/list` per session for every client, forever, in exchange for a surface that
is never stale. That is the same trade ADR-029 declined for config — it chose a notify over a poll
because config changes a few times a year — and it comes out the other way here, because the party
that would poll is the client, the interval is per session rather than per instance per minute, and
a missed notification is not detectable by anyone.

**A reload reports how many tools it now serves, and logs it.** `ReloadResult` carries the count,
`/reload` returns it, and `connect` prints it beside the line saying the endpoint re-read its
config — with the one action that picks it up:

```
Serving it now — the endpoint has re-read its config.
  42 tools are advertised now. A client connected before this keeps the
  list it already fetched — reconnect it to pick them up.
```

The endpoint re-reading its config and the client learning about it are different events, and the
command used to report only the first while the operator was looking at the second.

**`lanes link tools` asks the endpoint what it advertises.** One `initialize` and one `tools/list`
over the wire, printing the count, the names by provider, the payload size, and the declared
`listChanged`. Not derived from config: the question is what a client is being told, and a config
that says forty-two tools while a client shows two is exactly the case where a derived answer would
be believed.

Which sets the bar for its own failures, because each of them reads as an answer. It says whether
the address is the deployed one or the loopback fallback, since a `--target cloud` whose service
could not be located answers from `127.0.0.1` with a token `secrets push` made identical. It
separates *refused* from *unreachable*, because a rotated token and a dead port need opposite
fixes. It groups by resolving each wire name back to a capability id rather than splitting on the
first underscore, and files what it cannot resolve as unattributed instead of guessing. And it
exits non-zero when it could not answer, as `doctor` does.

**The generation logger is the endpoint's logger.** It was an inline no-op, so `could not reload
config`, `could not refresh skills`, and every `mcp handler error` went nowhere.

## Consequences

**A tool-less profile answers `tools/list` with an empty list.** Declaring the capability installs
the handler unconditionally, where before an endpoint with nothing registered answered `Method not
found`. That is the better answer, and for this ADR's own reason: "no tools right now" invites a
client to ask again, and "this server does not do tools" tells it never to.

**`connect` is honest about the step it cannot take.** Reconnecting a client is the operator's, the
same way authorising an account is (ADR-007). What changes is that the command says so.

**Nothing here can make a client re-read.** A client that ignores `listChanged` and caches
regardless is unaffected. The endpoint's obligation is to stop supplying a reason not to ask; it
cannot supply a reason to.

## What this does not do

**No notification is sent on the modern leg either.** The 2026-07-28 revision has an event bus and a
`subscriptions/listen` stream, so one could be. It is not, because the same value is declared to
both legs and a capability that is true only for clients on the newer revision is the ambiguity this
ADR removes.

**It does not cover skills.** A skill registers as a prompt, so it moves neither the count nor the
line `connect` prints — and skills refresh *within* a generation, on a poll, so no reload fires to
report one either. `docs/connect.md` says so where it tells an operator to compare the number
against their client, rather than leaving "nothing is stale" to cover a case it does not.

**The count is not audited.** `tools/list` still dispatches nothing and still writes no audit event.
It is logged once per generation instead — the question worth answering was "what is this endpoint
advertising", not "who asked", and a per-request record of a method that invokes nothing would dilute
a log whose value is that every row is a real call.
