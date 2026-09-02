# ADR-067: One directory per profile, and `data/` goes

**Status:** accepted · **Follows from** [ADR-066](066-a-profile-owns-its-data-again.md) ·
**Supersedes** [ADR-052](052-a-target-owns-its-workspace.md)'s filename ·
**Renumbers every connection id**

## Context

A profile was two places. Its declaration was `profiles/<name>.yaml` and its data was
`data/<name>/` — the same structure split across two folders, which nobody could state a reason
for beyond how it grew. ADR-066 gives a profile its bytes back, which makes the split visible
rather than merely untidy: everything a profile is, in two directories that must be kept in step
by hand.

And `data/` had stopped meaning anything. It meant "what a deployed revision writes, as against
the config it reads" — a real line, and the one `isWorkspaceConfig` and the IAM grant were drawn
on. Once the declaration moves in beside the bytes that line has to be drawn *inside* the
directory anyway, and a directory holding everything names nothing.

## Decision

**A profile is one directory, and the root is flat.**

```
~/.lanes-link/
├── workspaces.yaml              the registry, and the marker file
├── connections.yaml             every authorised account
├── credentials.enc              one credential per account
├── providers.d/                 the operator's own provider manifests
├── audit.log/                   one hash chain for the workspace
├── state.kv/                    connection records, discovery, this endpoint's OAuth server
└── profiles/<profile>/          everything one profile is
```

Every top-level entry is a thing rather than a wrapper, and `rm -r profiles/work` is again the
whole answer to "remove the work profile".

**`lanes-link.yaml` becomes `workspaces.yaml`**, matching the `workspaces:` key contract 3 already
renamed inside it (ADR-061). `resolveWorkspaceRoot` and `readWorkspace` answer to both names, and
nothing writes the old one: a workspace that needs migrating has to be findable by the command
that migrates it, which is the same reason `listProfiles` matches both profile shapes.

**The IAM write grant becomes an allowlist.** It was `objectsUnder('data/') && !manifests`. It is
now the writable prefixes named — `audit.log/`, `state.kv/`, `credentials.enc`, `profiles/` —
minus `profiles/*/profile.yaml`, because ADR-007 says a deployed revision never mutates its own
configuration and the declaration now sits inside the tree it writes. **Dropping `data/` does not
remove that exclusion**; it moves it. What it does buy is the shape: an allowlist says what a
compromised revision can reach, where a denylist says only what it cannot and grows silently every
time something new lands under the prefix it grants.

**Skills become profile-filtered on deploy, and manifests stay whole.** They sit at different
levels now and the filter follows: sending one profile's procedures on a deploy that does not
carry that profile would put its material in front of another's endpoint, while a manifest defines
a connection any profile may grant (ADR-057).

### Connection ids become opaque

`idFromAccount` derived an id from the account's local part, on the reasoning that it tells
accounts apart in practice. It does not: the same name at two domains gives `ada_lovelace` and
`ada_lovelace2`, and an id that half describes its account is worse than one that does not,
because it invites being trusted.

**`lan<n>` for a surface built into Lanes, `con<n>` for somebody's account.** The prefix carries
the one fact that stays true — whether there is a vendor behind the row — and everything else a
reader wants is `account` and `label`, one field each, changeable without moving a reference. So a
`relabel` can no longer move a `credential_ref`, a blob path, or a grant.

Three things settled it:

- **The provider id could not carry it.** Marking the built-ins by setting `provider: lanes` was
  the obvious alternative and breaks the policy model: the provider id *is* the capability
  namespace (`registry.ts`, "fully qualified: `notion.search`. What policy rules and audit events
  name"), so `lanes.*` would grant memory, vault, tasks and skills in one rule and lose the
  per-item `vault.get.<id>`. That is what `RESERVED_PROVIDER_IDS` exists to protect.
- **A leading letter, not a bare number.** Verified against the parser this repository ships:
  `id: 001` reads as the integer `1`, so `gmail.001` in a grant would match nothing and every id
  would need quoting forever.
- **Numbers are allocated workspace-wide and never reused.** Highest taken plus one, not the first
  gap, so an id in an audit log years later still means the row it meant then.

An id from before this scheme keeps working — opaque means opaque, so `main` is as legal as `con1`
and simply does not participate in the numbering.

## What this costs, stated plainly

**`listProfiles` no longer lists only declarations.** It reads the same `profiles/` prefix, but
matches `<name>/profile.yaml` rather than a direct `.yaml` child — so it walks each profile's
memory, tasks, assets and entities on the way past. `audit.log/` is the workspace's and is not in
there, so the largest collection by object count is not walked, and a local root is a `readdir`
rather than a network call. If it bites on a remote workspace the fix is a delimiter listing,
native on GCS and S3; noted, not built.

**A grant no longer reads as a sentence.** `gmail.con1` says less at a glance than
`gmail.ada_lovelace` did, and a profile's grants have to be read against `connections.yaml` to
know whose mailbox they name. That is the trade for an id that cannot be wrong, and it is paid
back where it matters most: the `connection` argument's description now carries the account and
the label, so the caller choosing between two accounts of one vendor is told which is which
instead of guessing from an id that only looked informative.

**It is a breaking change to every reference.** Contract 4 rewrites them in one pass — the rows,
the grants, credential refs, state keys, connection record bodies and blob paths — rather than
leaving two migrations over the same keys.

## What this does not do

It does not change any file's *shape*: `grants:`, `members:` and `connections.yaml` are as
contract 3 left them, and contract 4 is a relocation and a renumbering. It does not move
`connections.yaml` or the registry into `profiles/`, because both are read before any store is
opened and putting config inside the tree it configures is a cycle. And it does not merge the four
workspace stores: they are split by property — declared, secret, derived, append-only — and the
encryption boundary and the deploy allowlist are drawn on exactly those lines.
