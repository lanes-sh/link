# ADR-073: A connection names its own account

**Status:** accepted · **Follows from** [ADR-057](057-a-connection-belongs-to-the-workspace.md)

## Context

`settleIdentity` resolves whose account was just authorised, and it has always had a fallback:
where the provider will not say, ask the operator. The doc comment on that branch calls it a last
resort, and `identity.ts` opens by saying resolution is best-effort because "a label is worth
having, never worth failing a connect over".

It was not a last resort. Of 105 provider definitions, 30 declared an `identity` block and 75 did
not, so for most of the catalogue the prompt was the *only* path. The shape of the complaint that
started this is the whole argument:

```console
$ lanes link connect notion --profile personal
ok  authorised
Which account is this? (the address or handle):
```

A browser round trip had just established exactly who this was, and the next line asked. Worse,
the typed answer is load-bearing three times over — it is the key a reconnect matches on, the
source of the default label, and what `gmail.send_message` writes into a `From` header — so the
one field that most needs to be stable was the one field a human retyped from memory each time.

Notion is the instructive case because its omission was deliberate and documented: `get-users`
led with integration bots rather than the person and `get-teams` returned teamspaces, so both
"would produce a confident wrong label". That reasoning was right and has expired. Notion's
hosted server renamed those tools and added `notion-fetch`, whose id `self` returns the connected
workspace alongside the authenticated user's email — documented by Notion for this exact purpose,
labelling a connection after OAuth.

## Decision

**Identity is resolved in four steps, and the operator is the fourth.**

1. What the caller was given — `--display-name`.
2. What the connector knows, for a protocol that authenticates by username: the name the *server
   accepted*, which is a stronger claim than the one that was typed.
3. What the manifest declares — an `identity` block, `http` or `tool`.
4. What the authorization server will say — RFC 7662 introspection, or OIDC userinfo.

Only then the question.

**Asking the server is allowed; reading the token is not.** `oauth-exchange.ts` refuses to decode
the stored `id_token` because "the claim inside is unverified, and a tamperable local store is not
somewhere to read an identity from". Step 4 honours that rather than working around it: an
introspection or userinfo response is the issuer answering for itself, over the network, now.

**A probe may not guess.** Two rules follow from the mistake Notion's comment avoided, and both
are cheap to break by accident:

- A `field` names one value, never a collection. `pluck` walks into the first element of an array
  on the way past, so a path through a list resolves to whoever happens to be first and reads
  exactly like a working probe.
- A returned identifier that is not human-readable is refused. A uuid, a long opaque token, or the
  client id echoed back would become the account, the label, and the reconnect key, and would read
  like it worked. Falling through to the question costs a question; a wrong label costs a row
  nobody can correct without knowing it is wrong.

**A vendor whose user is scoped to a tenant carries a `qualifier`.** One person's Notion email is
the same email in every workspace they belong to, so without the workspace beside it a second
connect matches the first row and overwrites its credential. `http` carried a qualifier for Slack;
`tool` now carries one too, and `defaultConnectionLabel` keeps it rather than shortening it away.

**The gap is a ledger, not a footnote.** `src/providers/identity-coverage.test.ts` fails the build
when a provider neither declares an identity block, nor authenticates to nothing, nor is listed
with a written reason — and fails equally when an entry outlives the gap it records. A provider is
fifteen lines of data and adding one raises no question on its own, so the build raises it.

## Consequences

The generic step is small and measured rather than assumed: of the 80 MCP endpoints this
repository names, five advertise introspection and three advertise userinfo. That is the reason
the per-vendor sweep is the substance and step 4 is the cheap part — and the reason the ledger
exists rather than a claim that the problem is solved.

Sixty-nine hosted-MCP providers are still unswept. Every one of those servers refuses an
unauthenticated `tools/list`, so each identity call has to come from vendor documentation and each
block ships unverified until somebody holding an account on that vendor connects. That is a real
cost and the ledger states it per provider rather than hiding it in a total.

An unverified block is bounded in what it can do wrong: a wrong endpoint or a rejected token
answers null and the operator is asked, which is what happened before the block existed. The
hazard is a right endpoint and a wrong field, which is what the two probe rules above are for.

The empty answer changed with it. It used to be accepted and stored `${provider} ${provisionalId}`
— the provider's name beside `pending`, an internal token meaning "no id yet". It now re-asks, and
the way past is to type `blank`, which stores `unnamed` and takes a freshly allocated id rather
than matching another `unnamed`: two rows nobody could name are not evidence of one account, and
matching them would hand the second connect the first one's credential.
