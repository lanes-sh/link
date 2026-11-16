# ADR-083: Reach is resolved per request, and a removal ends the session

**Status:** accepted · **Amends** [ADR-060](060-a-caller-is-a-person.md) ·
**Completes** [ADR-082](082-a-routing-argument-names-no-set.md) ·
**Narrows** [ADR-079](079-the-dashboard-credential-names-a-person.md)'s revocation note

## Context

Adding a profile to a deployed workspace left a connected client unable to use it. That report had
two independent causes, and it closed on the first because the first was the one that was visible.

[ADR-082](082-a-routing-argument-names-no-set.md) fixed that one: `profile` and `connection` were
per-principal enums baked into every tool's `inputSchema`, so a client holding an older
`tools/list` validated against an enum without the new name and never sent the request. They are
plain strings now.

The second cause was never the schema. `IssuedTokenAuthenticator` built its principal from
`record.profiles` — the list resolved once, when the authorization code was minted, and copied
forward through every refresh rotation by `who()`. So a browser session's reach was frozen at
sign-in. A profile created afterwards could not be reached by that client *at all*, whatever the
schema said, and a member removed afterwards kept their reach for the full
`access_token_ttl_minutes` — twelve hours by default, with nothing in the CLI able to shorten it,
because nothing in the CLI reaches `OAuthStore`.

This is also why "reconnect the connector" always worked, and why that workaround was misleading:
reconnecting re-mints. It was treating the symptom of the second cause while the first took the
blame.

ADR-060 chose the freeze deliberately, and said why: re-reading membership per request "would mean
a profile edit silently ending a live session". That was a reasonable thing to protect in a
decision whose subject was delegation. It reads differently once the question is asked about
revocation rather than about sessions. **A grant that lands late is an annoyance; a revocation that
lands late is the security property failing**, and this was the slowest path in the system by three
orders of magnitude — every other credential landed a removal in seconds.

Two further things turned out to be true while this was being worked out, and both are the reason
the change is larger than one call site.

**Membership was answered three times, and the answers differed.** `membersResolver` read every
profile's YAML behind a five-second cache for a static token. `endpoint.ts`'s `membersOf` filtered
the *live runtime map* for the OAuth gate, for `lanesFederation` at the mint, and for the
signed-key link. `token list` asked a third, uncached way. Three implementations of one sentence is
how they came to disagree.

**One of those three read the wrong thing.** The runtime map holds the profiles that successfully
*opened*. A profile whose per-profile credential nothing had provisioned is skipped by
`openReconciled`, so it was absent from that map — and therefore its own members looked like
strangers. At the mint that was not subtle: the sign-in was refused outright with "no profile on
this endpoint lists you as a member", for a person the profile did in fact list. A provisioning
fault was being reported as a membership fault.

## Decision

### One rule, read from the declaration

All four credentials resolve membership through one implementation, `workspaceMembers`, and it
reads what the owner **declared** rather than what the endpoint managed to open.

Reading the declaration cannot widen what a caller touches, and that is what makes it safe rather
than merely tidier. `mergeCapabilities` iterates the served map and `mayReach` only filters it, so
a declared profile that is not being served contributes no capability, appears in no `/health`
list, and lands on the same word-for-word refusal as a profile that does not exist. What moves is
a membership answer that was never a membership question.

### It can tell unreadable from empty, which the old code could not

This is the part the rest rests on. `listProfiles` wraps its listing in `catch { return []; }` and
`loadWorkspaceProfiles` buckets every per-profile read failure into `unreadable` and returns
`loaded: []`. So a bucket 503, a throttle, or an expired metadata-server token produces *exactly
the value* that "this workspace has no profiles" produces.

That was survivable, and only by accident: the resolver's one live caller was
`BearerAuthenticator`, which returns `not_configured` before reaching it when the workspace holds
no token rows — the ordinary state since the endpoint stopped minting one. It stops being
survivable the moment an empty answer ends a session, because the first storage hiccup would then
401 every connected client at once, and a client's correct response to a 401 is to re-authorise.
The reply to a struggling bucket would be a stampede at `/authorize`.

So three states are distinguished where there was one:

- **Absent** is removed. Its members lose it, and its bytes leave the digest.
- **Unparseable** is that profile's own problem. It contributes no members and the pass still
  succeeds, so one typo cannot suspend revocation across the workspace. This also matches what is
  reachable: `openRuntime` cannot open a config that will not parse, so nothing is served under it.
- **Unreadable** is this process not knowing, answered with the last thing it did know — for a
  bounded time. Unbounded staleness is a revocation bypass however good the reason, because a
  bucket whose credentials were revoked fails every pass forever. Past the ceiling it throws and
  the authenticators fail closed, which is visible and recoverable where twelve-hour-old
  permissions are neither.

### Empty ends an issued session, and only that one

For an issued token, an empty resolved list refuses the credential. The client gets a 401,
re-authorises, and meets the mint's own explanation of why it cannot.

The asymmetry with the other three is deliberate and it is not arbitrary. `OAuthServer.callback`
refuses to mint a token for a member of nothing, so an issued token that resolves to empty **must**
have had its membership removed since it was minted. That is a revocation. For a static token, an
OIDC token or a signed key there is no mint gate, so empty may always have meant "never had any
reach" — which is an ordinary non-error pinned by four separate test files, and which
[ADR-082](082-a-routing-argument-names-no-set.md) improved two releases ago so that such a caller
is told by a refusal rather than by a schema nothing satisfies. A blanket rule would have reversed
that.

A browser session is also the only one of the four that is a *session*. The others are long-lived
machine credentials with nothing to end.

The two cases stay structurally separate in the code — a resolver that throws is caught apart from
a list that came back empty — and they are deliberately **indistinguishable on the wire**. Both are
`invalid`, both are a 401. `AuthOutcome`'s reasons are a closed set, and a sixth value would leak
"you exist but reach nothing" into a header, which is the disclosure property ADR-082 rests on.

### Two clocks, and the split is the security property

The hot pass re-reads `connections.yaml` and one config per *known* profile: a handful of small
reads and **no listing at all**. Every revoking direction lives there — a member removed, a grant
narrowed, a policy denied, a profile deleted — so removal converges within the hot window on every
instance, with no notify and no fan-out.

Discovering a profile that has *appeared* needs a listing, and that is a slower clock. It is the
one thing this cannot do quickly, and it is a grant: the direction the rule allows to be slower.
`/reload` remains its fast path, so in practice the endpoint hears about a new profile at once and
the slow clock is the floor under a notify that did not land.

The listing is on the slow clock because it is not cheap, and this is the one measurement the
design turns on. `listProfiles` records it in its own comment: the `profiles/` prefix walks every
memory entry and every asset in every profile on the way past. On a five-second clock that would
have made this change a latency regression dressed as a security fix.

`connections.yaml` is in the digest because `connect`, `connection declare` and `disconnect` all
write it at the workspace root. A stamp built only from `profiles/` would have left two whole
directions converging on nothing but a notify.

## What ADR-060 already claimed, and this makes true

ADR-060's revocation paragraph was corrected once already, to stop it naming
`lanes link token rotate` as the command that closes the window — it rotates one API token row and
says in its own output that browser clients are unaffected.

The corrected text then said that membership "is resolved **per request** for a static `llk_`
token, an OIDC token and a signed Lanes API key — the resolver reads the profile files behind a
five-second cache". **That was true of one of the three.** Only `BearerAuthenticator` used
`membersResolver`; the OIDC gate and the signed-key link were handed `membersOf`, which reads the
held runtime map — per request, but with no file read and no five-second window, so their freshness
was bounded by the last reload rather than by a clock.

So most of this decision makes ADR-060's own sentence true rather than contradicting it. The single
real reversal is the browser-session exception, and the paragraph recording it.

`ADR-079` carries a stale copy of the retracted claim in its own cost list, and it is corrected
alongside.

## What this costs

**A live session can now lose reach without asking for anything.** That is the point, and it is
still a cost: a client that was working stops working because an owner edited a profile, and the
401 it gets says only that it should authorise again. The owner's own command is what explains it,
and `profile members remove` is where that explanation belongs.

**A grant can widen a live session's reach without the client asking.** Reach still only ever
follows something the owner wrote, which is the invariant that matters — nothing widens because a
client asked again or because a cache expired in a convenient direction. But it is worth stating
plainly that consent at sign-in is now consent to whatever the owner declares later, not to the
list that existed at that moment. The stored list was a membership snapshot and never a consent
record — `OAuthStore` documented it as "the profiles whose `members:` named it at the moment the
flow completed" — so this takes nothing away that was being relied on. It does mean a member who
authorises a client is trusting the owner's future edits, which was already true of every other
credential.

**Reads, where there were none.** The hot pass costs `1 + N` small reads per instance per window,
lazily — an idle instance pays nothing, because the pass rides a request and every authenticator
reaches it only after the credential has verified. An unauthenticated caller still cannot make the
endpoint read its store, which was already the rule.

**The stored `record.profiles` is written and no longer read**, for one release. Removing the write
in the same change would create a one-way door: a token minted by the new revision has no list, and
rolled back to the previous one `record.profiles ?? []` yields an empty list, `ok: true`, and a
holder who reaches nothing silently with no 401 to prompt re-authorisation. The field is annotated
at its declaration with that reason and a deletion target, which is the device `LEGACY_WORKSPACE_FILE`
and the `--target` spelling already use. An un-annotated unread field is a trap; an annotated one
with an expiry is a plan.

## Alternatives rejected

**Re-mint on change.** Have the owner's command end and reissue affected sessions. Rejected: the
client is the party that would have to act, and the requirement is explicitly that no reconnect is
needed. It also cannot be done for a client that is not currently connected.

**Keep the freeze and add a kill switch only.** A command that ends a session would close the
compromised-token window, which is a real and separate problem. It does nothing for the reported
bug — a profile added after sign-in — and it leaves granting and revoking on different mechanisms,
which is how they came to have different latencies.

**Resolve from the served map rather than the declaration.** Cheaper, since the map is already
held. Rejected on the mint evidence above: it conflates a provisioning failure with a membership
failure, and it makes reach a property of what an instance managed to start.

**A per-request store read with no cache.** Correct and simple, and it puts a bucket round trip in
front of every authenticated request before any of the caller's work begins. The window is what
makes the cost bounded; the ceiling is what makes the window safe.

## What this does not do

**It does not make a cached `tools/list` fresh.** Nothing can push
`notifications/tools/list_changed` from a stateless endpoint ([ADR-002](002-transport-and-statelessness.md),
[ADR-032](032-a-stateless-endpoint-does-not-announce-its-tools.md),
[ADR-075](075-the-list-a-client-caches-must-stop-changing.md)), and `listChanged: false` and
`ttlMs: 0` are already sent and already ignored. A *new provider* still introduces a tool name a
cached client cannot see; ADR-075's answer to that is `lanes_tools_call`, and it already works.
"Runtime state" here means **reachable**, not re-advertised.

**It does not converge a change across instances by itself.** One notify reaches one instance
([ADR-029](029-connecting-is-not-deploying.md) names that as its own gap), and the member rows
converge on every instance only because they are read per request rather than held in a
generation. Grants, policy and connections still live in the generation. The digest this resolver
computes exists for that, and what consumes it is a separate decision.

**It does not shorten a leaked token's life.** Resolving membership per request does nothing for a
stolen credential whose member row is still there. That window is `access_token_ttl_minutes`, and
closing it needs a command that reaches `OAuthStore` and a token cache that can be dropped on a
warm instance.

**It does not change what is advertised, or any refusal's wording.** `mergeCapabilities`,
`allowedConnections` and `mayReach` are untouched, and the test that normalises the supplied name
out of the non-member and non-existent refusals and compares what is left passes unmodified. That
was the condition on the whole change.
