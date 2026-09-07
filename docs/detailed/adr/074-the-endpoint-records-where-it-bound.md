# ADR-074: The endpoint records where it bound

**Status:** accepted · **Follows from** [ADR-029](029-connecting-is-not-deploying.md), [ADR-009](009-one-endpoint-per-workspace.md)

## Context

ADR-029 separated a config edit from a deployment: an edit publishes itself and tells the running
endpoint to re-read, so connecting an account stopped costing a Docker build. Seven commands do
this — `connect`, `connection`, `grant`, `identity`, `members`, `policy`, `relabel` — and they
share one helper, `notifyReload`, which works out the address to POST `/reload` at.

It worked out the wrong address for most of them, and the way it was wrong is the reason this is
an ADR rather than a bug fix.

ADR-009 says one endpoint serves every profile in the workspace from one URL. `lanes link start`
binds **one** socket, and which port that is comes from the `instance.port` of the profile it was
started with. But `notifyReload` derived its address from the `instance.port` of the profile being
*edited*:

```ts
url = (await endpointUrl(input.config, declared)).replace(/\/mcp$/, '/reload');
```

For an edit to the profile `start` was run under, those two are the same number and everything
works. For an edit to any sibling they are different, and the notify goes to a port with nothing
behind it. For a profile that has just been *created* they cannot agree: its port is fresh, so
nothing has ever listened there.

The failure mode is the expensive kind. `notifyReload` catches a refused connection and reports
`no endpoint answered — saved, and the endpoint will serve this when it next starts`, which is the
true sentence for an endpoint that is **down**. So an operator with a running endpoint read a
plausible line, believed the edit would land on the next restart, and had a live endpoint serving
superseded config in the meantime. It is the same shape as ADR-032's stale tool list: the edit
succeeded, the surface did not change, and nothing said so.

`profile add` made it visible because it made it total. A new profile in a deployed workspace is
written straight into the bucket and is durable immediately, while the running revision — which
lists the profiles at boot and at a reload and at no other time — goes on serving the set it
found when it came up. The profile exists and is invisible at once, which reads exactly like a
dashboard that has not refreshed. `profile remove` is the same gap pointing the other way, and
worse: a profile whose credentials and stores have been deleted stayed reachable through the
endpoint, so "I revoked that" was not true yet.

## Decision

**The process that binds the socket writes down where it bound, and the commands that have to
reach it read that.**

`lanes link start` writes `endpoint.json` at the workspace root — the URL, the profiles it opened,
its own pid, and when it started. `notifyReload` now resolves an address in the order of who
actually knows:

1. **The platform**, for a deployed target. It assigns the hostname, so it is authoritative.
2. **The record**, for a local one.
3. **The edited profile's config**, when there is no record — which is the address this used
   unconditionally, so a workspace whose endpoint predates this is no worse off.

`profile add` and `profile remove` join the seven commands that publish, and a test asserts the
rule structurally: a command that calls `recordConfigChange` must also reach `publish.ts`, or name
itself as an exception with an argument. A hand-kept list of the seven would not have caught this,
because the list would have been written from the code as it stood.

### The record is a hint, and is allowed to be wrong

This is the part that makes it safe to leave a file like this lying around. `notifyReload` still
has to reach what the record names, and the POST carries this workspace's own bearer token, so
both ways it can be stale fail closed:

- **The endpoint is gone.** A `kill -9` skips the shutdown that clears the file, so the record
  outlives the listener. The reader checks the pid with signal `0` and answers null for a dead
  one, which returns the caller to the config-derived address it used before.
- **The pid was reused, or another workspace took the port.** A stranger does not accept this
  workspace's token, so the notify is refused rather than delivered to the wrong endpoint. This is
  the hazard `endpointHealth` was written to warn about — "two workspaces can assign the same
  port, so an endpoint answering is not the same as *this* profile's endpoint answering" — and it
  is why the answer is not simply "trust the file".

### Local roots only

Nothing is written for a `gs://` workspace. A deployment's address comes from the platform, and
ADR-007 says a revision never writes its own configuration — a record in the bucket would be a
revision announcing itself into the files it is forbidden to touch. For the same reason the write
lives in `commands/operate/serve.ts` rather than in `startEndpoint`, which the container
entrypoint also calls: the control plane records this, exactly as the control plane, not the
container, performs the owner-layer repair beside it.

## Consequences

A config edit reaches a running local endpoint whichever profile it touched, and `profile add`
against a live workspace now prints `Serving it now — the endpoint has re-read its config` instead
of nothing. A workspace gains one small file that is not config and not data, and which a reader
has to know is a hint — hence this record and the doc comment on `endpoint-record.ts`.

Two things are deliberately not solved here. The record says nothing about an endpoint started by
something other than `lanes link start`, which falls back to the old behaviour rather than
failing. And `profile add` reports its outcome only when the endpoint took the edit or the target
publishes somewhere: a new profile in a workspace that has never served has nothing holding a
stale view of it, and the no-endpoint line arrived as the first sentence this CLI ever printed,
describing an endpoint the reader had not set up yet.
