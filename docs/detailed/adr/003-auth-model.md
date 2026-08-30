# ADR-003: One token per profile; policy lives at the profile level

**Status:** accepted, amended by [ADR-009](009-one-endpoint-per-workspace.md) · **Milestone:** M1 ·
**Supersedes** init.md's per-client model

> **Amended in M2.** "One token per profile" is now "one token per *endpoint*". One
> `lanes link start` serves every profile in the workspace, so the token in the profile it was
> started with admits all of them, and each call names the profile it means. Everything below about
> there being no client entity and no per-client policy is unchanged — the token simply scopes to
> the endpoint rather than to one profile. See ADR-009 for what that costs.

## Decision

A profile has **one bearer token** and **one policy block**. There is no `Client` entity, no
`clients:` config block, and no per-client policy.

```yaml
auth:
  mode: bearer
  token_ref: profile/token

policy:                       # default deny
  allow:
    - { capability: "gmail.search", connection: "gmail.main" }
  deny:
    - { capability: "gmail.send", connection: "gmail.main" }
```

## Why this replaced per-client policy

init.md modelled a `Client` per consumer, each with its own token and rule set. That is one more
layer of indirection than the single-owner case needs, and the granularity it bought is available
more strongly elsewhere: **a narrower grant is a narrower profile**, and profiles already share no
database and no credential store. A policy row was never that strong a boundary.
> Amended by ADR-009: they do share an endpoint and its token.

Everything load-bearing survives unchanged — default deny, runtime enforcement per
capability+connection, policy-filtered discovery, tighten-only floor composition, control-plane
exclusion. What disappeared is indirection, not a boundary.

## What this trades

Stated plainly, and repeated in `https://lanes.sh/docs/link/security`:

- Two agents cannot hold different permissions against the **same** profile. They need separate
  profiles, which is heavier: a separate database, credential store, and port.
- Rotating a profile's token re-authorises every agent using that profile. `lanes link token rotate` says so.
- Audit cannot attribute a call to a specific agent. The MCP `clientInfo` name is recorded as an
  **observability-only** field and is never consulted for authorization — it is self-reported, so
  treating it as identity would be a hole rather than a feature.

## The seam that was kept

Policy evaluation is internally `(principal, capability, connection)`, and M1 always passes the
profile's single owner principal. That is one parameter, and it is what keeps init.md's
`delegation.external-clients` slot honest: adding delegated principals later becomes new rows rather
than a new signature on the dispatch path.

No other machinery was kept for it. There is no `clients:` block, no client CLI commands, and no
speculative approval engine.

## Rejected: auto-registering unknown tokens on first use

Convenient, and catastrophic: it is default-allow at the identity layer, and it is agent-initiated
control-plane mutation, which ADR-007 forbids.
