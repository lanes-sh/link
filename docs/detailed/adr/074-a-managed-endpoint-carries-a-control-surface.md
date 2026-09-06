# ADR-074: A managed endpoint carries a control surface, and is not on the internet

**Status:** accepted · **Amends** [ADR-007](007-control-plane-exclusions.md),
[ADR-018](018-the-gate-is-in-the-application.md) ·
**Follows from** [ADR-070](070-one-process-serves-many-workspaces.md),
[ADR-071](071-a-managed-workspace-is-a-workspace.md) ·
**Supersedes** the separate-service half of this repository's managed design

## Context

ADR-007 ends on a sentence this decision changes:

> A running instance, local or remote, never mutates its own configuration and exposes no
> administrative API. Configuration changes originate from the operator's CLI and arrive by
> deployment, so there is no admin surface on the public URL to attack.

A managed workspace has no operator's CLI. Nobody is going to type `lanes link profile add` on a
machine Lanes runs, so either the configuration is written by something reachable over a network or
it is not written at all.

The first answer was a **second service**: a control plane beside the endpoint, IAM-locked so only
`api.lanes.sh` could reach it, leaving ADR-007's sentence literally true of the endpoint. That
design was built to the point of a working gate before the reasoning under it was found to be
wrong, and the error is worth recording because it is the kind that survives review by sounding
careful.

**The claim was:** a managed endpoint must be publicly reachable, because Cloud Run IAM admits only
a caller holding a Google-signed identity token for the service, and no MCP client can mint one
(ADR-018). Therefore the control plane, which *can* be IAM-locked, must live somewhere else.

Every clause is true. The conclusion does not follow. It holds only if an MCP client connects **to
the endpoint**, and that was an assumption rather than a requirement.

## Decision

**`api.lanes.sh` is the only public surface. The managed runtime is
`--no-allow-unauthenticated`, and mounts the control routes itself.**

```
claude.ai ──► api.lanes.sh/mcp        public. authenticates. the only front door.
                    │  a short assertion Lanes signs
                    ▼
              lanes-link-managed      IAM admits the api's service account, nobody else
                                      /mcp   the runtime
                                      /v1/*  the control surface
```

Two consequences, and the second is the one that needs stating rather than implying.

**Cloud Run IAM is the outer gate**, so the assertion check is the second layer rather than the
only one. That is strictly better than the separate service had, where the control plane's own
signature check was all that stood in front of it.

**A managed revision can write its own configuration.** ADR-007's sentence is now false of one kind
of endpoint. A local or self-hosted one mounts none of this — `control` is absent from
`ServerOptions` on those binds — and for them the sentence stands unchanged.

## What ADR-007 still guarantees

Its letter changes; its purpose does not, and the purpose is the part worth being precise about.

ADR-007's unifying argument is that each excluded operation *authorises future agent behaviour*, so
the decision must originate outside the agent — and that content returned from upstream accounts is
untrusted, so prompt injection is an expected input rather than a hypothetical.

An agent reaching `/mcp` holds a token this endpoint issued or verified. The control routes take a
different credential entirely: an RS256 assertion signed by `api.lanes.sh`, verified against a
pinned public key, naming a subject, a workspace, a role and a set of scopes. **An agent cannot
forge one**, so it cannot widen its own access, which is the whole of what ADR-007 protects.

Three further things hold it up:

- **The two credentials never meet.** The control routes never pass through
  `options.authenticator`, exactly as ADR-063 requires of the read surface. One shared check would
  make the MCP bearer able to open the control plane.
- **Widening needs more than a role.** `WIDENS` requires `admin` *and* a `link:admin` scope the
  owner ticked when the connector was added. Being an admin is consent to administer; it is not
  consent for every agent holding your credential to administer.
- **The workspace is never an argument.** `workspaceRootFor` takes the verified assertion and
  nothing else, and no route reads a workspace from a path, a query or a body.

## What mounting made stronger

The router resolves a workspace from the request before the control handler runs, and the assertion
names one. Both are believed only where they **agree**, so a valid assertion for workspace A
arriving at workspace B's runtime is refused. Two independent statements of which tenant this is,
from different sources.

The separate service had only the assertion. This is the one property the merge improved rather
than traded, and it is worth noting because the rest of this decision reads as a simplification.

The refusal is an ordinary 404, identical to an unknown path: which of the two checks failed is the
log's business, and a caller who could tell them apart could enumerate tenants. ADR-007 makes the
same argument about capabilities, and ADR-070 about workspaces.

## What this costs, stated plainly

**A process that serves untrusted content can now rewrite configuration.** The managed runtime
parses mail, executes tool calls an LLM chose, and holds every managed workspace's credentials.
Adding a control surface to it means a compromise of that process is also a compromise of the
control plane.

The honest measure of that: it is small, because a compromise of a multi-tenant runtime already
yields every tenant's credentials. Rewriting configuration is a lesser prize than the refresh
tokens the same process already holds. The separate service did not protect against this either —
it protected against reaching the control plane *without* compromising the runtime, which is what
IAM now does instead.

**`api.lanes.sh` becomes a hard dependency for managed traffic.** A self-hosted endpoint answers
whether or not Lanes is up. A managed one will not, once agent traffic is proxied. That is a real
difference between the hosting options and belongs in the security model rather than being
discovered during an incident.

**The IAM condition has to widen.** `src/deployments/gcp/provision.ts` grants the revision
`objectViewer` on `profiles/`, which ADR-023 put there when image immutability stopped enforcing
"a revision never writes its own config". A managed revision now legitimately does, so its service
account needs `objectAdmin` — **for the managed deployment only**. Every self-hosted deploy keeps
the narrower condition, and that asymmetry is the point rather than an oversight.

## What this does not do

It does not change a self-hosted or local endpoint in any way: no control routes, same
`--allow-unauthenticated` for a deployed target that declares it, ADR-018's reasoning intact where
it still applies, and `src/dispatch/control-plane.test.ts` green without amendment — because
nothing here puts a control-plane capability on the *MCP* surface, which is the surface that test
guards.

It does not make the control routes reachable by an agent, a browser, or anything but the api's
service account.

And it does not give the managed runtime an OAuth authorization server of its own. It never speaks
OAuth to anyone: `api.lanes.sh` authenticates, and this runtime believes an assertion.
