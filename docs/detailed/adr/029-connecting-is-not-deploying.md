# ADR-029: Connecting is not deploying

**Status:** accepted · **Amends** [ADR-004](004-declarative-config.md), [ADR-019](019-describing-setup-is-not-performing-it.md) · **Pays one cost listed by** [ADR-025](025-connecting-an-account-from-a-deployed-endpoint.md)

## Context

Authorising an account against a deployed endpoint took two commands, and the second one built a
Docker image:

```console
$ lanes link connect gmail --target cloud
$ lanes link deploy                        # again, so the revision sees it
```

`https://lanes.sh/docs/link/deploy` documented that as the flow. Locally the same defect read as "stop `lanes link
start` and run it again".

Two mechanisms produced it, and they are independent.

**Config never reached a deployed target except through a deploy.** `connect --target cloud` wrote
the credential to Secret Manager, which is target-scoped and correct, and wrote the connection row
to the local `profiles/<p>.yaml`. The bucket copy the revision reads was refreshed by
`uploadWorkspace`, which had exactly one caller: `deploy`.

**The endpoint read its config once, at boot.** `openReconciled` opened a runtime per profile and
`serve` closed over a fixed map, so even fresh config in the bucket was not served by the revision
already running.

There was a third, quieter one. Connection *credentials* are read live on every call, so a fresh
`connect` looked like it should be picked up — but whether a connection was usable at all was
decided by a reconcile that ran once per process. A revision that came up with an account
unauthorised went on refusing it, and the refusal named the connection rather than the staleness.

None of this is a deployment concern. A deploy is how new code reaches the endpoint. Which mailbox
that endpoint can read is a different question, and tying the two together meant every account
change cost an image build — and meant `deploy` could not be described as being about code.

## Decision

**An edit publishes itself, and says so.** `publishWorkspace` answers where a target's endpoint
reads its config; a command that edits config copies it there and then asks the endpoint to
re-read it. `connect` does this, and so do `policy allow` and `policy deny`. `deploy` still
publishes on the way past, because a first deploy must seed the bucket before the revision boots.

**The endpoint takes an authenticated `POST /reload`.** It re-opens and re-reconciles the whole
workspace: connections, `policy.allow` and `policy.deny`, `oauth_apps`, the operator's own provider
manifests, and which profiles the workspace holds. One code path — `openReconciled`, the same one
boot uses — rather than a filtered subset that could drift from it.

**Runtimes live in a generation, and a request pins one.** The map of profile runtimes is replaced
wholesale, along with every cache derived from it: the handler memo, the visible-tool set, the
capability-id list, the skill poll clock. A request acquires a generation on the way in and uses it
throughout, so a reload landing mid-request cannot change what that request is evaluated against
between two of its own awaits.

A replaced generation is *retired*, not closed. `Runtime.close()` ends connector sessions and writes
the audit log's end marker, and an in-flight request is still using both, so the pin doubles as a
reference count and the last request out closes it.

**A failed reload is reported, not fatal.** A profile caught mid-write answers `{reloaded: false}`
with the reason, and the generation already serving stays current. This is the discipline
`refreshSkills` has always used, for the same reason: a config file someone is editing must not be
able to take down an endpoint that is serving perfectly well.

## Why a route rather than a poll

A poll would have been self-healing — it picks up a hand-edit, and an edit made from another
machine, with no notify to miss. It costs a `list()` on the config prefix per interval per instance,
forever, to catch an event that happens a few times a year.

The notify is exact and free at rest. Its weakness is that it reaches one instance, which is the
subject of the next section.

## What this amends

**ADR-004's second clause.** "A deployed instance never mutates its own configuration and exposes no
administrative API." The first half is untouched and is the load-bearing one: `/reload` re-*reads*;
it cannot write. Config still flows one way, local CLI to instance. What changes is *when* the
instance looks, and the second half of that sentence is now false — there is one authenticated route
that is not `/mcp`. It takes no parameters, so the only thing a caller can ask for is "read what is
already there".

**ADR-019's "a new connection is not served until the endpoint restarts."** That section ends *"a
live reload wants its own decision, because 'a running instance never mutates its own configuration'
is adjacent enough to matter."* This is that decision, and the adjacency resolved the way the
sentence hoped: re-reading is not mutating.

**One of ADR-025's five costs.** "A config-reload story" is paid. ADR-025's own argument is
untouched — it is about whether an *agent* may connect an account, and connecting is still a CLI
act performed by the person who owns the browser (ADR-007). What is gone is the objection that such
a flow "either ends with redeploy, which loses most of its point, or reload becomes its own
decision".

## What this does not do

**One notify reaches one instance.** Cloud Run may hold several, and a second warm instance that
missed the POST would keep refusing the account — making "connecting needs no redeploy" true only
sometimes, which is worse than reliably false because nobody can reproduce it.

The error path closes it rather than a poll. A call naming a tool this endpoint does not advertise
looks exactly like a call naming a tool that appeared a moment ago; one reload tells them apart, so
an unrecognised tool name provokes one reload before it is recorded as a refusal. Bounded to once
per ten seconds, and nothing on the success path pays for it. An instance that never receives such
a call is serving nothing that needs the new config anyway.

**`instance.port` and `instance.host` are not reloaded.** A reload cannot move a bound socket.

**The authenticator and the authorization gate are not reloaded.** They are built once from the
runtime the endpoint booted with, so rotating the profile token still needs a restart. Retiring the
boot generation stays safe for them because `Runtime.close()` does not close the credential store or
the state handle they hold — which is load-bearing rather than incidental.

**The vault still does not reload.** ADR-012 §3 makes a vault write unreadable until the next start
deliberately: a write cannot hand itself a read. That is a property, not a limitation, and a general
config reload must not quietly undo it.

**`target use` publishes nothing.** It rewrites which target this CLI addresses. No endpoint serves
it.
