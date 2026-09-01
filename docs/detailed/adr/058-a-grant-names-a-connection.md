# ADR-058: A grant names a connection, so scopes differ per account

**Status:** accepted · **Supersedes** [ADR-003](003-auth-model.md)'s "rules name capabilities,
never connections" · **Follows from** [ADR-057](057-a-connection-belongs-to-the-workspace.md)

## Context

A policy rule has never named an account. `policySchema` is one `allow` list and one `deny` list
for the whole profile, and the schema says why:

> Rules name capabilities, never connections. Every account of a provider in a profile is governed
> identically, and granularity comes from running a narrower profile.

`allowedConnections` implements exactly that, and is explicit about it — it filters to the
capability's own provider and then goes all-or-nothing:

```ts
// All or nothing beyond that, since rules do not discriminate between
// accounts. The list shape is kept because it is what the `connection` enum
// wants, and because a future principal-scoped rule would restore the
// filtering without touching any caller.
```

That was a good trade while a connection lived in exactly one profile, because **the second
profile was the granularity**. Two mailboxes governed differently meant two profiles, and two
profiles shared no store and no credential, which ADR-003 correctly calls a stronger boundary than
a policy row.

ADR-057 removes the mechanism that made it work. A connection now lives in the workspace and any
profile may select it, so "run a narrower profile" no longer produces a narrower *grant* — it
produces a second selection of the same account, with the same flat rule set applied to it. The
granularity has to move into the rule, because there is nowhere else left for it to be.

The thing this makes expressible is the thing the product is for: one profile that reads a mailbox
and writes a calendar, and another that reads the calendar and sends as the mailbox, over the same
two accounts, authorised once.

## Decision

**A profile's policy is a list of rows, each naming one connection.**

```yaml
grants:
  - connection: gmail.personal
    allow: [gmail.users.messages.list, gmail.users.messages.get, gmail.users.threads.*]
  - connection: gmail.work
    allow: [gmail.*]
    deny:  [gmail.send_message]
  - connection: calendar.personal
    allow: [calendar.*]
```

Everything load-bearing from ADR-003 survives unchanged, and is worth listing because a change to
the policy engine invites reading more into it than is there:

- **Default deny.** A connection with no row is not reachable and not advertised. An empty
  `grants:` grants nothing at all.
- **Deny wins**, regardless of order, within the row that governs the call.
- **Tighten only.** The instance floor is still evaluated first and its denial is still final.
  Composition can narrow and can never widen.
- **`approval_required` is still reserved** and still treated as `deny` until an approval engine
  exists.

**There is no profile-wide `allow` beside the rows**, and that is deliberate. A second place a
connection could be granted is a second answer to "may this call proceed", and the whole shape of
ADR-052 is that two answers to one question is the defect rather than the convenience.

**`PolicyRequest.connection` becomes load-bearing.** It has been carried since M1 "for audit, not
for the decision"; the field does not change, the reason it is there does.

**`allowedConnections` stays the single implementation.** It evaluates each candidate connection
rather than answering once per provider, and discovery (`server/mcp/visibility.ts`) and
enforcement (`dispatch/dispatch.ts`) keep calling the same function. Computing visibility a second
way is how a filter and a gate come to disagree, and a leak in discovery is still a leak.

## What this costs, stated plainly

**A profile file is longer, and repetitive by construction.** Eight connections is eight rows,
and a profile that genuinely wants the same rules everywhere now writes them eight times. That is
the honest cost of removing the shorthand, and it is not worked around with a wildcard row: a
`connection: '*'` would be exactly the second grant path this decision refuses.

**`policy allow` and `policy deny` require `--connection`.** A rule has to land somewhere, and
there is no longer a single block to append to. The refusal names the connections the profile
holds, so the flag is discoverable from the error rather than from the docs.

**`connect` no longer writes a grant**, because it no longer writes into a profile at all
(ADR-057). The first-impression argument ADR-003 made for `allow: ['*']` moves to `profile add`
and to `lanes link grant <connection>`, which writes the row and the wildcard together.

**A denial reads differently in the log.** `denied_by_policy` used to mean "this provider is not
permitted here"; it can now mean "not for this account". The event already records the connection,
so nothing is lost — but anyone reading old and new events together should know the predicate
changed.

## What was considered and rejected

**Keeping the flat block and adding per-connection overrides.** Two places, precedence rules
between them, and the same "which one answered" question ADR-037 spent a whole decision removing.

**Rules that name a connection pattern** — `gmail.*` on the connection axis as well as the
capability axis. It reads as symmetry and is not: a capability pattern narrows a vendor's own
namespace, which the operator does not control, while a connection id is a name the operator
chose. A pattern over names they chose buys brevity and costs the property that you can read a
profile and see exactly which accounts it reaches.

**Per-capability grants on the connection row instead of allow/deny lists.** Rejected on grounds
of parity: `capabilityPattern` and the `allow`/`deny` pair are what `policy list`, the audit log,
the instance floor and every existing profile already speak. Changing the rule grammar and its
location in one release would make the migration two changes instead of one.

## What this does not do

It does not add a principal to a rule. Who may call is decided one layer up, by the profile's
members ([ADR-060](060-a-caller-is-a-person.md)), and a grant row is about the account rather than
the person. It does not introduce ordering between rows — a row governs exactly its connection and
rows cannot interact. And it does not change what a capability *is*: the vendor still names the
operations, and `capabilityPattern` still admits `*`, `gmail.*`, and a trailing `.*` at any depth,
and nothing else.
