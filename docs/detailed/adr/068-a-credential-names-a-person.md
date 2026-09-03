# ADR-068: A credential names a person, and the profiles follow from that

**Status:** accepted · **Completes** [ADR-060](060-a-caller-is-a-person.md)'s
`kind: 'machine'` · **Closes** [ADR-009](009-one-endpoint-per-workspace.md)'s stated gap ·
**Amends** [ADR-043](043-a-target-scoped-command-acts-on-the-target.md),
[ADR-057](057-a-connection-belongs-to-the-workspace.md) · **Contract 5**

## Context

`lanes link mcp add` required `--profile`. Tracing what it did with it turns up something larger
than a stray flag.

It did two things, and neither is a per-profile fact. It read
`runtime.config.auth.token_ref` — a ref whose template default is the **constant** `profile/token`
for every profile, out of a credential store that has been one per workspace since ADR-057 — and
it interpolated the name into one Codex hint string. Two different `--profile` values against the
same workspace produced byte-identical harness commands.

`profile/removal.ts` records what that shared constant already cost. Removing one profile deleted
the endpoint token its siblings were being served by, and the deployed revision then refused every
request. The fix at the time was a survivor check: do not delete a ref another profile also
declares. That works and it is the wrong shape, because the token was never a profile's to declare.

**The deeper thing is that this endpoint had two credentials answering two different questions.**
ADR-060 and ADR-062 built the model: a caller authenticates as a person, and the profiles they
reach are every profile whose `members:` names their subject. `mayReach` is the check,
`visibility.ts` filters the `profile` enum from the same list, and `Dispatcher.invoke` refuses
ahead of policy. An OAuth token has gone through that since 0.8.

The static `llk_` token did not. It resolved to `ownerPrincipal` of whichever profile was primary,
with `profiles: undefined` — which `mayReach` reads as *all of them*. So it was the one credential
here that answered **what may I open** without ever answering **who are you**. ADR-060 described
the principal that would fix this, named it `kind: 'machine'`, and nothing ever minted one.

That is ADR-009's gap, and it is why every command whose subject is the endpoint had to name a
profile: not because the endpoint is per-profile — it is not, one endpoint serves every profile in
the workspace — but because finding the credential meant resolving one.

## Decision

**A credential names a person. What it reaches follows from that, and from nothing else.**

The endpoint's tokens move to `tokens:` in `connections.yaml`, one row per token:

```yaml
tokens:
  - { id: tok1, subject: lanes:<subject>, ref: tokens/tok1, label: ci }
```

`auth.token_ref` leaves the profile schema. A profile declares no endpoint credential.

**Resolution goes through the member lists, exactly as OAuth does.** `BearerAuthenticator` is
handed the rows and a `profilesFor(subject)` resolver — the same closure shape `server/endpoint.ts`
already builds for the authorization gate — and returns `machinePrincipal(subject, primary,
profiles)`. `mayReach` and the enum filter need **no change**: the bearer path joins the path that
already worked, rather than getting a second mechanism beside it.

**Membership is resolved per request for a static token**, and that is a difference worth stating.
An OAuth token's profile list is fixed when the code is minted (ADR-060) because there is a mint to
read it at. A static token has none, so this is the only place the question can be asked — which
makes `profile members remove` take effect within the authenticator's cache window rather than on
the next rotation. A resolver that throws fails closed; falling back to "every profile" would
restore precisely what this removes, at the moment something is already wrong.

**`--profile` goes from every command whose subject is the endpoint.** `mcp add`, `mcp stdio`,
`outputs` and the whole `token` family move to `workspace` in `src/cli/selection.ts`. The three
token commands that could only ever have been misread — `show`, `rotate`, `revoke` — **refuse**
the flag rather than accept and ignore it: somebody passing `--profile work` believes they scoped
the credential, and the member lists are what decide. That is the rule `selection.ts` was written
for.

**`start` and `deploy` stop minting or demanding a token.** Both halves go for the same reason.
Minting: `start` did it because there was one token per endpoint and it had to exist for anything
to connect; a token names a person now, and `start` does not know who is about to connect, so
inventing one would bind a credential to a subject nobody chose. Demanding: a deployed revision
refused to boot without one, on the reasoning that an endpoint whose token nobody holds is no use.
Since ADR-062 that is backwards — a client discovers the protected-resource document, signs its
owner in, and comes back with a token of its own. **Zero rows is the ordinary state of a healthy
endpoint**, and refusing to serve was refusing the case the endpoint is now built for.

`token issue`, `token list` and `token revoke` are the commands that follow from rows existing.

## What this costs, stated plainly

**A CI runner that relied on one token opening the whole workspace needs a subject that is a member
of each profile it uses.** This is the point of the change rather than an incidental cost, and it
is the one thing that can break an existing headless caller. The migration binds the existing token
to an owner of a profile that held it, so a single-profile workspace is unaffected; a runner
reaching three profiles needs that subject on all three.

**The migration cannot invent a subject, and refuses rather than guessing.** A row bound to the
wrong subject is worse than no row: it looks issued and reaches nothing, or reaches somebody
else's profiles. So the subject comes from the owner-role member of a profile that actually held
the token, and where there is none — a workspace migrated by contract 3 while signed out has
`members: []` — contract 5 stops and names `profile members add --me`.

**The credential is not re-keyed.** A row may name any ref, and the migrated row keeps
`profile/token`. Renaming it to `tokens/tok1` would read better and would mean copying a live
credential in a store that may be Secret Manager, then deleting the original — two writes and a
window where a deployed revision reads neither. The one thing that must not break during an
upgrade is an endpoint that was working before it.

**`ProviderContext` gains a field**, and that interface is deliberately narrow. `profiles` is the
caller's reachable set. The argument for it is that it is not a handle: it is the same routing fact
the client already holds in the `profile` enum on every tool it was shown, and a provider still
acts in exactly one profile per dispatch. It is there because a surface that describes what a
caller can reach has to be given the caller's answer rather than the workspace's.

**No client needs re-adding.** ADR-066's lesson is that the provider ids are the wire; this renames
no id, no tool and no connection. `update` should not grow another "re-add every client" line for
this.

## Two things found on the way, and both were live

**`lanes_setup.overview` named every profile on disk.** It was handed `listProfiles(root)` and
printed `This endpoint also serves: …`, so a delegated member read the names of profiles `mayReach`
deliberately keeps out of the `profile` enum they were shown. It now renders the caller's set and
says only *how many* it is withholding — a count is not a leak, and it is what stops an agent
concluding the others do not exist.

**`/health` did the same thing.** Authenticated, it returned every profile the endpoint serves to
anybody holding any credential. Same rule as discovery, in the one place that had its own answer.

**`ensureRegistryContract` stamped the newest contract mid-chain.** After the contract-4 step the
registry claimed 5 while its profiles said 4, and `isUnmigrated` reads exactly that field — so it
would have reported a finished migration with a step still to run. Each step now stamps the
contract it produces.

## What was considered and rejected

**Keeping the token where it was and only dropping the flags.** Smaller, and it leaves the actual
defect in place: the credential would still reach every profile regardless of who holds it, and
the flags would be gone without the reason they existed being gone. ADR-009's gap would survive in
the one place nobody was looking at.

**Per-profile tokens** — ADR-060 considered and rejected these, and the reasoning holds: a token is
a bearer string, so per-profile tokens buy isolation without buying attribution, and the audit log
would still record which profile rather than which person.

**Deriving the subject at authentication time from the token's own bytes** — a token that encodes
its subject needs no registry. It also cannot be revoked without one, cannot be listed, and changes
the token format, which invalidates every existing credential on upgrade.

**Caching the resolved profile list beside the token value.** One fewer read per request. It also
makes `profile members remove` take effect on the next rotation rather than in seconds, which is
the property the per-request resolution is for.

## What this does not do

It does not change that the `profile` argument is client-supplied per call. ADR-009's remaining
concern — that cross-profile access is a matter of what the model passes — is *narrowed* by this
and not closed: a caller can still name any profile they are a member of. It does not change what a
grant means; who may call and what they may call are still two questions answered in two places.
And it does not make roles decide anything at the MCP boundary (ADR-060), because nothing here
needed a second policy system.
