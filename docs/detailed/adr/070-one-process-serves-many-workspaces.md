# ADR-070: One process serves many workspaces, and the boundary becomes a code path

**Status:** accepted · **Amends** [ADR-009](009-one-endpoint-per-workspace.md) ·
**Follows from** [ADR-023](023-the-workspace-is-not-in-the-image.md),
[ADR-029](029-connecting-is-not-deploying.md) ·
**Requires** [ADR-071](071-a-managed-workspace-is-a-workspace.md)

## Context

`docs/detailed/init.md` says it plainly: *"Deployments are single-tenant. Run one instance per
profile, so personal and work never share a database or credential store."* ADR-009 widened that
to one instance per *workspace* and left the rest standing. `src/server/container.ts` reads
`LANES_LINK_HOME` once at boot and serves that workspace for the life of the process.

That is right for a self-hosted deploy and it is the thing a Lanes-hosted one cannot do. A managed
workspace is not rare: once Lanes Forms becomes an owner-layer provider, every Lanes workspace has
one. A Cloud Run service per tenant is a service, a service account, a set of secrets and a cold
start per tenant, against a per-project service cap, for a discriminator a string already provides.

So one process serves many. **The honest way to state that is not "we added multi-tenancy" but
"the boundary that used to be a process is now a code path"**, and this record exists to say what
holds it up rather than to imply nothing changed.

## Decision

**A workspace router above the generations, and two stores scoped beneath them.**

```
                    request
                       |
         router   (workspace <- Host)         src/server/router.ts
                       |
      Generations  (one per workspace)        src/server/generations.ts
                       |
        Generation  (one boot's runtimes)     src/server/generation.ts
```

The layering is the point. `Generations` already held a workspace's runtimes and swapped them on
reload (ADR-029); the router is that map one level up, holding a whole `RequestHandler` per
workspace. A reload inside one workspace cannot disturb another, because a generation belongs to a
handler and a handler belongs to one workspace.

`container.ts`'s single-workspace mode is untouched. A self-hosted deploy runs the code it ran
before.

## What the router does that is not obvious from its shape

**An `open` promise is stored before it resolves.** Two requests arriving together for a cold
workspace share one open rather than building two handlers and leaking whichever loses.

**A failed open is not cached.** A bucket that was briefly unreadable must not become a workspace
that stays broken until the process restarts.

**An evicted resident is retired, not closed.** `inFlight` is incremented before the fetch and the
close waits for zero, so a handler pushed out of the cache under load is not closed underneath a
request already committed to it. That is the same reason ADR-029's generations are retired rather
than closed when a reload replaces them, applied one level up.

**A request naming no workspace and one that will not open get the same 404.** Answers that
differed would let a caller enumerate tenants by watching which hostnames fail which way. ADR-007
makes this argument about capabilities — an unknown capability is refused identically to a denied
one — and it holds here for the same reason. The real cause goes to the log.

## The two stores that would otherwise still be shared

A router that only routed would leave two things process-global, and both were.

**A credential reference was unique only because a project had one workspace.** `encodeRef` maps
`tokens/tok1` to the secret id `tokens__tok1`, flat within a Secret Manager project. Two workspaces
in one project both write it, so the second `set` adds a version to the first workspace's secret
and both then read one refresh token. `GcpSecretManagerStore` takes a `namespace`, prepended to the
reference *before* encoding — so the separator collision `encodeRef` already refuses per reference
is refused once for the namespace too, rather than reintroduced by a second encoding. The reference
is validated before the namespace is prepended, or the malformed `nonamespace` becomes the
well-formed `<workspace>/nonamespace` and a namespaced store accepts what an unnamespaced one
refuses.

**A vault key came from the process environment.** `LANES_LINK_VAULT_KEY` reached both deployed
vault adapters, so one key would open every tenant's vault and rotating one workspace's key was not
expressible at all. Both adapters take a `keySource`. The existing `encryptionKey` was the wrong
shape: it is eager, so a host would fetch every workspace's key to build stores that may never
touch the vault — a network round trip per request, and a failure mode for requests that had
nothing to do with the vault. A `KeySource` resolves on first use and is cached by the store.

The blob root needs nothing: it is per workspace already, because the router resolves it.

## What this costs, stated plainly

**Isolation is now a property of code rather than of the operating system.** A self-hosted
deployment gets its boundary from the fact that another tenant's bytes are not in the process. Here
they can be, and what stands between them is: a handler built from the workspace it was resolved
for and from nothing a request body can influence, a credential namespace, and a vault key source.
Three things that can have bugs, where there used to be one thing that could not.

**A bug in the router is a cross-tenant data leak**, which is a different severity from the bugs
this repository has had before. That is the reason the two scoping changes landed first and with
tests that fail the *old* way — the credential test asserts that workspace A's `get` does not
return workspace B's token, and it did before the fix.

**Memory is bounded by a cap rather than by the platform.** One workspace per process meant Cloud
Run decided how much memory a workspace could have. An LRU with an idle eviction decides now, and a
cap set too high is an OOM that takes every resident workspace down rather than one.

**A noisy workspace is now somebody else's problem.** Per-profile rate limits still apply, but a
workspace doing enormous work occupies a process other workspaces are served from.

## What this does not do

It does not change what a request may reach. `mayReach`, the policy evaluation and the member
lists are untouched, and a caller still reaches exactly the profiles their subject is a member of.
It does not give the endpoint a control plane — ADR-007 is unmoved, and
`src/dispatch/control-plane.test.ts` passes unchanged. And it does not apply to a self-hosted
deployment, which resolves one root at boot exactly as it did.
