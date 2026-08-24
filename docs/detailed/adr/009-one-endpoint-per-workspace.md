# ADR-009: One endpoint serves every profile

**Status:** accepted · **Milestone:** M2 · **Supersedes part of [ADR-003](003-auth-model.md)**

## Decision

`lanes link start` serves **every profile in the workspace from one URL, under one token**. Each tool
carries a required `profile` argument beside `connection`, and the caller names which profile a call
acts within.

`--only` serves the resolved profile alone, which is the previous behaviour.

## What this replaces

M1 through M2.9 held that *one profile = one config = one instance = one endpoint*, and that
profiles shared no database, no credential store, and **no URL**. The last of those three is now
false, deliberately.

## Why

The isolation was real but the cost landed on the wrong person. Reaching three profiles meant three
registrations in every agent that needed them, and three port numbers to keep straight — and ports
are an implementation detail nobody chose to care about. In practice an owner registers every
profile with their own agent anyway, at which point the agent holds all three tokens and the URL
separation is protecting against a threat that was never present.

## What it costs, stated plainly

**One token now reaches every profile, and the caller chooses which.** Before, a leaked token opened
exactly one set of accounts, and registering only `personal` with an agent meant `work` was
genuinely out of reach. Now neither is true. Cross-profile access is a matter of what the model
decides to pass in an argument, which puts it one prompt injection away.

This is a real reduction in what the system guarantees, and it should not be described as a
refactor. It was chosen knowingly, and the mitigation — origin or client binding, so that a token
plus a caller identity determines the reachable profiles — is unbuilt. **Until it exists, treat the
endpoint as trusting whoever holds the token with everything the workspace holds.**

## What survives

- **Policy is still evaluated per profile.** The named profile's rules decide, and a capability no
  profile grants is not registered at all.
- **Profiles still share no database and no credential store.** What one holds is invisible to
  another; a note written through `personal` is simply absent in `work`. This had two exceptions
  when it was written — skills and provider manifests, both at the workspace root — and
  [ADR-030](030-a-profile-owns-its-skills-and-manifests.md) removed them, so it is now true
  without qualification.
- **Every call records its profile** in the audit log.
- **A mismatched pairing is refused.** The `connection` enum is a union across profiles, so a caller
  can name a valid profile and a connection belonging to a different one. That is checked before
  dispatch, because routing a `work` account through `personal` would cross exactly the boundary
  profiles exist to hold.
- **The workspace boundary is unchanged.** A token that must not reach two profiles belongs in a
  second workspace, which shares nothing at all.

## Capabilities merge rather than duplicate

Two mailboxes in different profiles are still one `gmail.users.messages.list` tool. The `profile`
enum lists the profiles granting that capability; the `connection` enum is their union. This keeps
ADR-001's reasoning intact — one tool set per provider, scaling to any number of accounts — and
extends it to any number of profiles.

Resources carry both in the URI, since a resource has no arguments to route on.

## Consequences

**The token is endpoint-scoped, not profile-scoped**, and the config comment says so. `auth.token_ref`
in the profile you start with is what opens the endpoint; the other profiles' tokens open nothing
while it is running.

**`lanes link outputs` describes an endpoint**, not a profile — one URL, the profiles reachable
through it, one registration command. It reports when something else holds the port, because two
workspaces can both assign 7337 and calling that "running" would point someone at another
workspace's accounts.

**An agent must be told which profile it means.** The bundled skill says to ask rather than default
to the first, since profiles are how someone separates work from personal and quietly picking one
crosses that line.
