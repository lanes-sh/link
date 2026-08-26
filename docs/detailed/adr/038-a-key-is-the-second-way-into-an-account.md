# ADR-038: A key is the second way into an account

**Status:** accepted · **Follows from** [ADR-028](028-a-hosted-oauth-client-is-the-default.md)

## Context

Every Google connection had to be re-authorised weekly, and the reason was not the one the code
said it was. `shared/oauth.ts` claimed the hosted client escaped the seven-day refresh-token
expiry "because that expiry is a property of a project left in 'Testing' and this one is not."
The premise is right and the conclusion was wrong: the expiry follows the client's **publishing
status**, which is a different setting from its verification status, and a client under review
has whatever status it has. Meanwhile `shared/setup.ts` told operators taking the
bring-your-own path to *leave* their own client in Testing, and closed by telling them to expect
to re-run `connect` every week.

So both routes into a Google account expired weekly, one by accident and one on purpose, and the
document explaining verification read as though verification were the only way out.

Publishing an unverified client to production is most of the fix and is not a code change — it
is one setting, and it costs an "unverified app" screen plus a lifetime cap of 100 new users that
cannot be reset. That is the right trade for a client one person uses and the wrong one for a
client handed out, which is why it is a documented choice rather than a default.

It also does not help at all where an organisation forbids publishing, and it does nothing about
the deeper property: an authorization-code refresh token lives or dies by policy applied to
somebody's consent, and that policy is not the operator's.

## Decision

A provider may declare a second way in, `auth.assertion` — RFC 7523, where the operator holds a
private key, signs a short-lived JWT, and exchanges it for an access token. There is no refresh
token, because there is nothing to refresh. `lanes link connect` offers the choice where a
provider declares one and asks nothing where it does not.

Four things about the shape, each of which had an obvious alternative that is worse:

**It is not a fourth `auth.kind`.** It hangs off the `oauth` block. A `kind` is what a provider
*is*, and these providers are not two providers — Gmail reached by a key is the same Gmail with
the same scopes, tools, redaction and policy. Making it a `kind` would have forked
`credentialRefForConnection`, `setupRequirements`, `rotatableCredentialRefs` and the deploy
grants, each into two branches that must agree forever.

**The stored credential's shape is the switch, not a field in config.** `credentialResolver` is
handed a registry and a secret store and never a connection row, so a declaration in config would
be invisible at precisely the point the decision has to be made. Both methods write to
`<provider>/<connection>`; one blob has `access_token`, the other has `grant`. This is the same
device `profileHasOwnClient` already uses — what is stored *is* the declaration — and it has the
same property: there is one record of the fact, so there is nothing to disagree with.

**The key is per profile and the subject is per connection.** One key covers every provider of a
vendor. Storing it per connection would mean pasting the same file seven times and rotating seven
copies of it. What genuinely differs per connection is who the key acts as, and that is a small
non-secret value that rides in the pointer beside the reference to the key.

**The minted token is cached in memory and never written back.** The authorization-code path
persists its rotation because the refresh token *is* the credential. Here the credential is the
key, which nothing at request time modifies — so persisting the access token would make this ref
rotatable, and a deployed revision would need write access to a secret it only ever reads, to
cache something that costs one signature and one POST to remake.

## Consequences

The weekly re-authorisation is escapable three ways now, in increasing order of effort: publish
the client, register your own and publish that, or connect with a key. The first two are
documented in `setup/google.md` and are not code.

The key route reaches less, and the manifest has to say how much less. A service account is an
identity in its own right: it has a Drive and a calendar, and no mailbox, contacts or task lists.
So Drive, Sheets, Docs and Calendar work by sharing a resource with the key's address — which
also means nothing in the account moves until it is shared, a real narrowing and not only a cost.
Gmail, Contacts and Tasks work only where a Workspace administrator has granted domain-wide
delegation, and not at all on a personal account. `delegation: 'optional' | 'required'` is that
distinction, and it decides both the sentence printed beside the choice and whether a blank
subject is accepted. A `required` provider refuses one, because a key acting as nobody
authenticates perfectly and then reads every mailbox as empty — a wrong answer that looks like a
right one.

`--auth <method>` is the non-interactive answer, and deliberately the only one: a run with nobody
to ask does not guess, because guessing picks which credential gets overwritten.

**A connection authenticates one way at a time, and connecting again replaces it.** Both routes
write to `<provider>/<connection>`, `settleIdentity` resolves a re-run of `connect` on the same
account back to the connection that already holds it, and the credential is overwritten in place
— so switching an account from the browser to a key, or back, is a re-run of `connect` and needs
nothing removed first. There is one connection and one credential afterwards, and the last run
wins.

The prompt says so rather than defaulting to the route already stored. Defaulting was tried and
was wrong twice over. Mechanically it could not work: the route was read under the *provisional*
connection id, which is `pending` until identity is settled, so it found nothing every time and
fell back to the browser — performing the silent swap it existed to prevent. And in principle it
answers the operator's question by reading their credential, which puts the consequential half of
the decision behind a default that reads as a no-op. A sentence can be read; a default cannot.

Two things it does not do. It does not revoke the grant it replaced: switching a connection from
the browser to a key overwrites the stored token and leaves the issuer holding a live
refresh-token grant for that account, which has to be withdrawn in the vendor's console. And it
does not remember the subject — every connect asks who the key acts as, because remembering would
mean reading the existing connection, which is the thing that was removed.

Two costs worth stating plainly. A key never expires, which is the feature and also means a
leaked key is good until someone deletes it — there is no consent to withdraw and no token to
age out. And domain-wide delegation is a large grant to ask an administrator for; the walkthrough
names the exact scope list rather than letting someone approximate it, because an approximation is
refused identically to a missing one and the refusal does not say which scope was short.

## What this does not change

Nothing about a connection that authorised in a browser. The union of `auth.kind` is untouched,
the credential ref is unchanged, and a manifest that declares no `assertion` block reads, behaves
and prompts exactly as it did — including the warning above, which is printed only where there is
a choice to warn about. Connecting GitHub, Slack or iCloud asks nothing and says nothing new.
