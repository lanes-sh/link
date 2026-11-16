# ADR-060: A caller is a person, and a profile declares who may consume it

**Status:** accepted, revocation paragraph amended by
[ADR-083](083-reach-is-resolved-per-request.md) · **Fills the seam kept by** [ADR-003](003-auth-model.md) ·
**Closes most of** [ADR-009](009-one-endpoint-per-workspace.md)'s stated gap ·
**Amends** [ADR-018](018-the-gate-is-in-the-application.md)

## Context

ADR-003 built policy around `(principal, capability, connection)` and then always passed the same
principal. It said why:

> That is one parameter, and it is what keeps init.md's `delegation.external-clients` slot honest:
> adding delegated principals later becomes new rows rather than a new signature on the dispatch
> path.

The slot has been empty since M1, and ADR-009 named what the emptiness costs. One token opens
every profile in the workspace, and the mitigation — "origin or client binding, so that a token
plus a caller identity determines the reachable profiles" — is recorded there as **unbuilt**, with
the instruction to treat the endpoint as trusting whoever holds the token with everything the
workspace holds.

Two things have changed that make this the moment.

**A profile is now worth sharing.** ADR-057 and ADR-058 turn a profile into a named capability
grant over accounts that exist independently of it. "Read the shared mailbox, do not send" is a
thing to hand somebody. Under the old model handing it over meant handing over a token that also
opened everything else.

**Lanes already knows who people are.** Workspaces, members and roles exist end to end — the
tables, the invitations, `GET /v1/me`. There is an identity to name, and it is the one the person
already signed in with.

## Decision

**A profile declares its members, and a caller is authenticated as a person.**

```yaml
members:
  - { subject: <lanes uid>, role: owner }
  - { subject: <lanes uid>, role: member }
```

```ts
export interface Principal {
  readonly id: string;                     // the Lanes subject
  readonly kind: 'owner' | 'member' | 'machine';
  readonly profiles: readonly string[];    // every profile whose members list this subject
}
```

**Identity comes from a Lanes sign-in, on every endpoint including loopback.** How a client
obtains one is [ADR-062](062-the-consent-page-asks-lanes-who-you-are.md); what this decision adds
is that the resulting subject is matched against `members:` before anything else happens.

**The check is one line, ahead of policy.** `Dispatcher.invoke` refuses when the named `profile`
is not in `principal.profiles`, and `server/mcp/visibility.ts` filters the `profile` enum from the
same list — so a member does not merely fail to call a profile they are not on, they never see it
exists. Discovery and enforcement share the answer, which is the same rule ADR-003 set for
capabilities and for the same reason.

**Roles are `owner` and `member`, and they decide nothing at the MCP boundary.** Both reach
exactly what the profile's grants allow. `owner` is who may edit the member list, and that is a
CLI act (ADR-007). A role that changed what an agent could call would be a second policy system
beside ADR-058's, and there is no question the first one cannot answer.

**`kind: 'machine'` is the one principal not backed by a person.** The static `llk_` token
resolves to it, it reaches every profile in the workspace, and it exists for a headless runner
with no browser. That is ADR-009's gap, surviving in exactly one place instead of in every
registration.

## What this costs, stated plainly

**Running this now requires a Lanes account.** A local, self-hosted, Apache-2.0 MCP server cannot
start signed out. That is a real change in what the project is, and it is not softened by calling
it optional somewhere: the member list is how a profile decides who may consume it, and a member
list with no identities to match is not a mechanism.

What bounds it is that the dependency is on **sign-in and refresh, not on every call**. A session
is cached; a machine offline for a day keeps serving. `lanes auth status` reports when the session
expires and whether it can still refresh, because the failure this produces — an endpoint that
worked yesterday — deserves a command that explains it rather than a 401.

**A revoked member is not instantly locked out, and which credential they hold decides how long
"not instantly" is.** Membership is resolved **per request** for a static `llk_` token
(`BearerAuthenticator`), an OIDC token (`OidcAuthenticator`) and a signed Lanes API key
(`LanesKeyAuthenticator`) — the resolver reads the profile files behind a five-second cache — so
`profile members remove` takes effect on their next call.

A browser session is the exception, and it is the one that matters, because it is what a hosted
client holds. `IssuedTokenAuthenticator` takes the list that was resolved when the code was minted,
deliberately: re-reading it per request would mean a profile edit silently ending a live session. So
a removal stops the next sign-in and lets one already made run its course.

**Nothing closes that window.** This paragraph used to say "takes effect on the next token exchange,
or immediately on `lanes link token rotate`", and the second half was false. `token rotate` rotates
one API token row, it needs an `--id`, and it says in its own output that clients which signed in
through a browser are unaffected; nothing in the CLI reaches `OAuthStore` at all. Naming it was
worse than saying nothing, because an operator who ran it would be told something had been rotated
and would believe the access was gone. Until a command exists, the window is
`access_token_ttl_minutes` — twelve hours by default, ADR-035's reasoning unchanged — and
`profile members remove` prints exactly that rather than naming a command.

Deleting the **profile** is immediate, by a different route: the generation stops serving it, so no
principal's baked-in list matters. The same goes for a profile a caller was never a member of.

Stating it plainly is the point: this is delegation, not a session manager.

**A workspace bound to a Lanes workspace inherits its membership as a source of truth.**
`profile members add` validates a subject against `GET /v1/workspaces/{id}/members`, so a person
removed from the Lanes workspace can no longer be added — but the rows already written are not
revoked by that removal. Nothing reconciles the two automatically, and pretending otherwise would
be worse than the gap.

## What was considered and rejected

**Per-profile tokens** — the other half of ADR-009's mitigation. It closes the same gap for the
static token and it is genuinely smaller work. Rejected as the *answer* rather than as an
addition: a token is still a bearer string, so per-profile tokens buy isolation without buying
attribution, and the audit log would still record which profile rather than which person. It
remains available and is not in this release.

**Roles that narrow capabilities** — `member` gets read, `owner` gets write. It reads as obviously
right and it is a second grammar for what ADR-058 already expresses per connection, with
precedence rules between them. If two people need different scopes, that is two profiles, which
is now cheap.

**Reading membership from the API on every request.** Correct, and it makes the endpoint's
availability depend on ours. The profile file is the source of truth and the API is consulted when
the list is *edited*, which is the same shape as every other piece of configuration here.

## What this does not do

It does not let an agent edit a member list, add itself, or read one it is not on. It does not
attribute a call to a client — MCP `clientInfo` is still self-reported and still observability
only (ADR-003). It does not change what a grant means: who may call and what they may call are two
questions, answered in two places, and this is only the first.

## Amended by ADR-083

The model stands whole: a caller is a person, a profile declares who may consume it, and
`members:` is the one list that decides. What changes is one paragraph — the revocation one above
— and most of that change is this decision's own sentence becoming true.

**The browser-session exception is withdrawn.** The paragraph above says
`IssuedTokenAuthenticator` takes the list resolved when the code was minted, "deliberately:
re-reading it per request would mean a profile edit silently ending a live session". That is now
the point rather than the objection. Membership is resolved per request for every credential,
including this one, and an issued token that resolves to nobody is refused
([ADR-083](083-reach-is-resolved-per-request.md)). A grant that lands late is an annoyance; a
revocation that lands late is the security property failing, and this was the slowest path in the
system — twelve hours by default, against seconds for everything else.

**The five-second claim was true of one credential, not three.** The paragraph says membership is
resolved per request for a static `llk_` token, an OIDC token and a signed Lanes API key, "the
resolver reads the profile files behind a five-second cache". Only `BearerAuthenticator` did that.
The OIDC gate and the signed-key link were handed a closure over the *live runtime map* — per
request, but with no file read and no window, so their freshness was bounded by the last reload.
Worse, that map holds the profiles which successfully *opened*, so a profile whose credentials
nothing had provisioned made its own members look like strangers; at the mint it refused the
sign-in outright, reporting a provisioning fault as a membership fault. All four now read the
declared config through one implementation, which is what this paragraph described all along.

**"Nothing closes that window" no longer holds, and `profile members remove` is what closes it.**
This paragraph was corrected once before, to stop it naming `lanes link token rotate` — which
rotates one API token row and says in its own output that browser clients are unaffected. The
honest version then was that the window was `access_token_ttl_minutes`. It is now the resolver's
own window, in both directions.

**What this decision got right and keeps.** Reading membership from the API per request is still
rejected, for the reason stated above: the profile file is the source of truth and the API is
consulted when the list is *edited*. Nothing here reaches `api.lanes.sh` on a request. Per-profile
tokens are still rejected, roles still decide nothing at the MCP boundary, and the inherited
Lanes-workspace membership is still unreconciled.

One cost this decision stated is now larger and should be read with the amendment: a live session
may lose reach, and may also gain it, without the client asking for anything. Consent at sign-in
is consent to what the owner declares later rather than to the list that existed at that moment.
The stored list was always a membership snapshot rather than a consent record, so nothing that was
being relied on is taken away — but it is a sharper statement of the same delegation this decision
chose, and ADR-083 says so where a reader will find it.
