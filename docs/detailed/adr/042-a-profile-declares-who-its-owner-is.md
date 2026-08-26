# ADR-042: A profile declares who its owner is

**Status:** accepted · **Follows from** [ADR-019](019-describing-setup-is-not-performing-it.md) · **Extends** [ADR-007](007-control-plane-exclusions.md) · **Obeys** [ADR-037](037-a-command-names-what-it-acts-on.md)

## Context

A profile says what is reachable — connections, credentials, what policy permits — and said
nothing about whose accounts those are. The account label on a connection is the closest thing,
and it answers a different question: it is the identity a *provider* reports, resolved at connect
time, so it says which mailbox this is rather than what to sign a message from it with.

So an agent writing as the owner had to infer. Composing an email, opening a pull request,
choosing a display name, signing off — every one of those needs a name or an address, and the
only source was whatever happened to be in the conversation. The observed failure is not a wrong
guess in isolation; it is a guess that crosses profiles. Two profiles exist precisely because the
same person is two people to two sets of accounts, and an agent with no declaration reaches for
whichever name it saw most recently.

The information is knowable. Nobody had written it down, because there was nowhere to write it.

## Decision

**A profile may declare an `identity` block: a flat list of `{kind, value, note}`.** `kind` is any
identifier, `value` is the name or address, `note` is prose saying when that one applies.

```yaml
identity:
  - { kind: name,   value: Ada,             note: use for open-source work }
  - { kind: name,   value: A. Lovelace,     note: use on anything published }
  - { kind: email,  value: ada@example.com }
  - { kind: github, value: octocat }
```

**A list rather than a map, because the note is the point.** `names: [Ada, A. Lovelace]` cannot
say which to use when, and an owner with two names has two for a reason. Declaration order is
preserved and meaningful: the first of a kind is the default, and the surface says so, because a
model handed two with no ranking picks by position anyway and may as well be told that position
is what it means.

**`kind` is free-form.** Shipping an enum would mean a release every time someone wants
`linkedin`, `pronouns`, or `signature`, and there is nothing the schema could do with the
knowledge that a value is an address that would be worth that cost.

**`note` is prose, not a reference.** Binding an entry to a connection was the obvious
alternative and is a trap: it would put a cross-reference into `assertReferentialIntegrity`, and
renaming a connection would then break config *load* — a profile that stops opening because a
name in a signature moved. An agent reading "use with the personal mailbox" gets it right and
costs nothing the day that mailbox is renamed.

**It lives in the profile YAML, so editing it is CLI-only.** ADR-007 keeps configuration mutation
off the MCP surface because it authorises future agent behaviour. That argument is sharper here
than anywhere it has been applied: an agent able to edit this could edit the one fact that stops
it signing as the wrong person. A store would have made an `identity_write` tool the obvious next
step, and it is exactly the tool that must not exist.

**It is read through its own provider, `identity`, with one read capability.** Reporting it
authorises nothing — the ADR-019 argument — and the disclosure is already made: a caller holding a
grant on a mail connection has the owner's address from the first message it reads. Withholding it
here while serving the mailbox would be theatre, and the point of reading it here is not having
to guess.

Its own provider rather than a third section of `setup_overview`, because `identity.*` is then a
grant an owner can give or withhold on its own. An endpoint can describe what is connected
without naming its owner, or name its owner without describing what is connected. Folding it into
`setup` would have made those one decision, and they are not one decision.

**The MCP instructions carry a pointer, not the data.** One fixed paragraph, conditional on the
surface being reachable, telling the agent to call `identity_list`. Inlining the declaration was
tried on paper and is wrong twice over: `MAX_INSTRUCTIONS` is a fixed ceiling, so the workspace
with the most identities to keep apart is the one whose list would be summarised away first — and
it would send every profile's names to a client that asked about none of them. A pointer costs
the same at one profile as at twenty, and the tool has room for the notes, which are the half
that actually prevents the mistake.

**`identity add` provisions the surface on first use.** An `identity` block alone is inert:
`allowedConnections` returns nothing for a provider with no connection row before it consults
policy, so the surface is absent from `tools/list` with nothing saying why. The command therefore
writes the entry, the connection row, and the `identity.*` allow rule in one `save()` — one save
because `validateConfig` refuses an allow rule naming a provider with no connection, so a
half-applied run would leave a profile that no longer loads. This is the same repair `setup`
already needed, generalised rather than copied.

## Consequences

The ceiling on the instructions rose from 2300 to 2500. That is the second raise, and it was
argued the same way as the first: the paragraph must reach a client holding no skills directory,
and an agent signing as the wrong person has already sent the message — a skill loaded only when
relevant is not loaded at the moment it happens. The measured worst case is 2474, so the number
is a measurement plus a little.

A fresh profile gets nothing. `newProfileTemplate` is untouched, so no connection row, no grant,
and no instruction paragraph until something is declared — the cost is paid only by a profile
that has an identity to keep straight.

Removing the last entry leaves the connection and the grant in place. The surface then reports
that nothing is declared, which is honest and visible; revoking it would mean the next
`identity add` silently re-widened policy, and a command that quietly narrows what an agent may
read is worse than a surface reporting nothing.

The block is the first place a profile holds the owner's own prose, which puts it under
`secret-detection.ts` like every other value. A note cannot trip the entropy rule — `OPAQUE_TOKEN`
admits no spaces — and a credential pasted into a value is refused, which is the check working
rather than a false positive to route around.

## What this does not do

It does not bind an identity to a connection, an account, or a provider. It does not let an agent
write, edit, or reorder one. It does not validate a value against its kind — an `email` entry
holding something that is not an address is the owner's to notice. It does not reconcile with the
`account` label on a connection, which answers a different question and stays where it is. And it
does not put any of it in the instructions, so what a client learns without asking is that the
declaration exists.
