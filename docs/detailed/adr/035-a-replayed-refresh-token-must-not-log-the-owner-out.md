# ADR-035: A replayed refresh token must not log the owner out

**Status:** accepted · **Supersedes** the replay half of [ADR-018](018-the-gate-is-in-the-application.md)

## Context

The endpoint issues its own OAuth tokens, and rotates refresh tokens. A spent one is kept as a
`consumed` tombstone rather than deleted, because a token that is simply absent cannot be told
apart from one that never existed — and a tombstone is therefore the only signal available that a
refresh token has been copied.

What the endpoint did with that signal was revoke the whole family:

```ts
if (record.kind === 'consumed') {
  await this.#options.store.revokeFamily(record.family);
  return invalid('invalid_grant', 'That refresh token has already been used.');
}
```

The reasoning was sound in isolation. Rotation alone does not answer a replay: whoever refreshes
first walks away with a live pair, so rejecting only the token in hand leaves that pair working and
locks out the other party — usually the real client. A retry and a theft are indistinguishable from
here, and re-authorising looked like the cheaper of the two mistakes.

Against a real connector it was the more expensive one, by a wide margin. Two properties combine:

- **A family is minted once and never rotates.** `#exchangeCode` creates it; every subsequent
  refresh passes `record.family` straight through. One authorization, one family, for its whole
  life.
- **A tombstone lives as long as the refresh token it replaced would have** — thirty days.

So every token ever issued under one authorization stays able, for a month, to delete whichever
pair is currently in use. The trigger is not a thief. It is a second session, another device, or a
client retrying a response it never saw.

Observed on a deployed endpoint, in one sequence:

```
11:11:27      POST /token  200                     rotation; new pair in family F
11:55:40.458  POST /mcp    401  reason=invalid     a stale access token, already swept
11:55:40.603  POST /token  400                     the matching stale refresh token, replayed
                                                   -> revokeFamily(F) deletes the LIVE pair
11:55:41 …    POST /mcp    401  reason=missing     the connector now holds nothing
11:58:29      POST /register -> /authorize -> /token   the owner re-approves in a browser
```

The replay arrived forty-four minutes after the token was spent, with a rotation in between — so no
grace window short enough to be a theft signal would have caught it. Three full re-authorizations
were recorded in twenty hours, each one an owner interrupted mid-conversation to complete a browser
flow.

It was also invisible. `revokeFamily` logged nothing and the token endpoint's `400` carried no
detail, so what the endpoint's own logs showed afterwards was a run of requests with no credential.
Reconstructing the cause meant reading object timestamps out of the state bucket.

## Decision

**A replayed refresh token is refused on its own, once it is old enough to be a
replay. The family survives either way.**

```ts
if (record.kind === 'consumed') {
  const spentAt = record.consumedAt;
  if (spentAt !== undefined && this.#now() - spentAt <= REFRESH_REUSE_MS) {
    return this.#issue(record.clientId, record.scope, randomToken('llr'), record.family);
  }
  this.#options.log?.warn('refresh token replayed', {
    clientId: record.clientId,
    family: record.family,
  });
  return invalid('invalid_grant', 'That refresh token has already been used.');
}
```

**Thirty seconds of it is not a replay at all.** A client whose refresh succeeded but whose
*response* was lost holds a token the server has already spent, and sending it again is the only
move it has. The reference MCP client rethrows every `OAuthError` but `server_error` rather than
recovering from it, so answering that retry with `invalid_grant` does not produce a retry — it
produces a dead connector and an owner sent to a browser, over a network blip. Inside the window
the request is the one already answered and the client is owed the answer. The band is the one
Auth0's reuse interval (0–60 s) and Okta's grace period occupy.

A fresh pair rather than the one already issued, because tokens are stored hashed: returning the
same strings would mean keeping them in plaintext for the window, which is a worse trade than
issuing again. A tombstone written before this existed carries no `consumedAt` and falls through
to the refusal, which is the safe direction and needs no migration.

Rotation is unchanged in what it is for — the spent token stops working, now shortly after the
real client rotates it rather than instantly. The tombstone is unchanged, and now earns its keep the way it always should have: by making
the replay *visible* rather than by triggering a revocation.

**The authorization server takes a logger.** Structurally typed rather than `#connectivity`'s
`Logger`, because `src/architecture.test.ts` has `auth` depending on `secrets` and `stores` and
nothing else; the endpoint passes the logger it already holds. Refusing a credential without
recording it is what turned a one-line diagnosis into log forensics, and this is the line.

**`revokeFamily` stays on the store, uncalled.** It is the shape a deliberate revocation takes —
one authorization's whole chain, dropped on purpose — and deleting it would mean writing it again
the first time that is wanted. Its doc comment says nothing reaches it, so a future call site reads
as new policy rather than as the old one returning.

## Consequences

**A captured refresh token keeps working for up to thirty seconds after the real client next
rotates it**, and **a replayed one no longer invalidates a pair a thief may hold**. That is the
whole of what is given up, and it is worth stating without softening: if a refresh token is copied and the
thief refreshes first, the thief's pair keeps working and the real client's replay is merely
refused.

Three things bound it. Registration is open, but a client that has registered holds only an
identifier — it must still complete an approval the owner performs by hand, at a consent screen
that demands the endpoint token. The access token it could steal is one credential among the
several this endpoint already treats as bearer authorization, which
[`security.md`](https://lanes.sh/docs/link/security) states plainly rather than implying otherwise. And the revocation
that matters is unchanged: `lanes link token rotate` replaces the token every consent depends on.

Against that: the behaviour being removed was firing on a real, approved client roughly daily and
had never once fired on a theft.

**The invariant table changes.** `oauth.refresh-replay-revokes-the-chain` becomes
`oauth.refresh-replay-is-refused-and-recorded`, and
[`src/server/oauth.test.ts`](../../../src/server/oauth.test.ts) asserts the new shape over real
HTTP: after a replay from any depth in the chain, the live access token still opens the resource
and the live refresh token still refreshes.

## What this does not do

**It does not fix a connector that drops its own credentials.** The same investigation found two
other re-authorizations with a different signature — the client presenting no credential at all
while a valid access token sat in the store, and, in one case, letting an access token expire
without ever attempting a refresh whose token was weeks from expiring. Nothing reached the endpoint
in either case, so nothing here is involved and nothing here can help. What the endpoint can do
about that is shrink the window: the default access-token lifetime moves from one hour to twelve,
which is the subject of the field's own comment in `src/profile/authorization.ts` rather than of
this record.

**The window is not what fixes the incident above.** That replay arrived forty-four minutes after
the token was spent, with a rotation in between; no interval short enough to mean anything would
have caught it. The two changes answer different failures and neither substitutes for the other —
dropping the family revocation is what saves a live session from a stale copy, and the window is
what saves a client whose refresh response never arrived. An earlier draft of this record rejected
the window on the strength of that measurement alone, which was the right measurement applied to
the wrong question.

**It does not audit the replay.** The audit log records what a caller *did*, and a refused refresh
has no principal. It goes to the endpoint's operational log, beside `rejected request`, for the
same reason that one does.
