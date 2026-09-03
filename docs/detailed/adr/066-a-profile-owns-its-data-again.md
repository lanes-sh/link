# ADR-066: A profile owns its data again

**Status:** accepted · **Reverses the storage half of**
[ADR-059](059-the-owner-layer-is-instances.md) · **Restores**
[ADR-030](030-a-profile-owns-its-skills-and-manifests.md)'s isolation and
[ADR-009](009-one-endpoint-per-workspace.md)'s "profiles share nothing" ·
**Keeps** [ADR-057](057-a-connection-belongs-to-the-workspace.md) and
[ADR-058](058-a-grant-names-a-connection.md) whole

## Context

Contract 3 did two things at once, and only one of them was asked for.

ADR-057 moved every *account* up to the workspace: one authorisation per account, a profile
selecting from them. That is right and is untouched here.

ADR-059 went on to move the owner layer's *bytes* up beside the connection, so
`memory/main/<id>.md` belongs to the instance rather than to any profile. Its argument was that
sharing should be the owner's choice — "a note taken while doing work is useful when reading
personal mail" — and that two profiles granting different instances still share nothing.

The argument is sound and the default undoes it. `newConnectionsTemplate` writes one instance of
each surface and `newProfileTemplate` grants all of them, so **every profile a workspace creates
points at the same memory**. Somebody who makes a `work` profile to keep work separate gets a
`work` that reads `personal`'s notes, and nothing tells them. The choice ADR-059 offered is real
but it is exercised by editing YAML that nobody has a reason to look at.

Two smaller things point the same way.

**A profile stopped being a container, and the word did not stop meaning that.** ADR-030 put it
plainly: a procedure "names things: which mailbox to file into, which people to copy" and is
exactly as private as the knowledge it operates on. That is still true. Under ADR-059 the file
path stopped expressing it and a grant expressed it instead, which is one indirection between the
owner and a property they thought they had.

**`knowledge:` never followed.** It is per profile and the stores it redirects were per
connection, and the gap has cost a real bug: `layout.blobs()` being the whole workspace meant a
prefix of `memory/` matched *every* profile's memory, so `knowledge use github --migrate --profile
personal` committed `work`'s notes to personal's repository and then deleted them locally
(`cli/commands/knowledge/migrate.ts`). `grantedInstances` exists only to paper over that.

## Decision

**The profile goes back in front of the bytes, and the instance stays behind it.**

```
profiles/<profile>/
├── state.kv/            cursors, and each provider's own keys
├── vault.d/<id>.enc     one sealed document per vault connection
├── skills.d/<id>/       one set of procedures per skills connection
└── <provider>/<connection>/…   memory, tasks, assets, entities, vendor blobs
```

Both segments are in the path. So two profiles granting `memory.lan1` share nothing — the shipped
default is isolation again — and one profile may still hold two memories by granting two
instances, which is the half of ADR-059 that survives.

**One line of code expresses it.** `openStorage` returns a factory whose omitted `area` is the
blob root; changing that base from `layout.blobs()` to `layout.blobs(profile)` makes every
provider blob per profile at once, with no change to `scopeNamespace` or `buildProviderContext`.
That is worth recording because it is the strongest evidence the boundary was in the right place
already and only pointed at the wrong thing.

**State splits by what a key is *about*, not by who reads it.** Connection records, the discovery
cache and the endpoint's own OAuth authorization server stay at the workspace: a `connect` run
once must read as connected from every profile, which is ADR-057's "two profiles share its
reconcile state". Cursors and each provider's own keys follow the profile, because two agents
reading one mailbox at different rates must not consume each other's position.
`isWorkspaceNamespace` is that rule, and it is closed — a namespace it does not name is the
profile's.

**The audit log stays one chain**, for the reason ADR-020 gives: one endpoint serves every
profile, every event already records the profile it acted in, `audit tail` filters rather than
selects, and one hash chain is stronger tamper-evidence than several.

## What this costs, stated plainly

**Cross-profile sharing is gone, with no replacement.** Two profiles granting one memory instance
read two memories. That is the point, and someone who wanted ADR-059's behaviour has lost it: a
note is now written once per profile that should see it, or kept in a repository both point at
through `knowledge:`. An opt-in `shared:` flag on a connection row would restore it and is
deliberately not built — the default is the whole of what went wrong, and a flag nobody sets is
not a fix for a default nobody chose.

**`rm -r profiles/work` comes back, and so does what it implies.** ADR-059 replaced it with
`lanes link disconnect memory.acme`, which is a better answer for an *account*. It is the wrong
answer for a profile's own material, because there was no such thing any more. There is again,
which is what makes `profile remove` able to ask whether to delete the data or migrate it into
another profile — a question that had no meaning while a profile owned nothing.

**Two profiles that were sharing one instance are two copies after the migration.** Contract 4
copies such a store into each granting profile and leaves the original, because merging two sets
of notes is not reversible and picking one profile's would take the other's away in silence. The
operator is told and deletes what they do not want. That is the only step in the migration that
is theirs rather than ours, and it exists because the shipped default made the shared case common.

**Every client registered before the migration holds a tool list that no longer resolves.** The
owner layer's provider ids gained `lanes_`, and `toolNameFor` only swaps `.` for `_`, so renaming
the provider renamed the tool: `setup_overview` is `lanes_setup_overview` now. The connection ids
were renumbered alongside them, and those are the `connection` enum on every tool in the list. A
client that re-reads is unaffected and sees both. A client that cached answers
`Tool setup_overview not found` for each `lanes_*` tool and has every `connection` value it was
given refused — while the vendor tools, whose ids did not change, keep their names and fail only on
that argument. Half the surface working is what makes it read as a broken endpoint rather than a
stale list, from the only side anybody is looking at.

This is the cost `What is unchanged` below does not cover, and the reason it was missed: no file's
shape changes at contract 4, so nothing in the migration looks like a wire change. The ids *are*
the wire. [ADR-032](032-a-stateless-endpoint-does-not-announce-its-tools.md) settles what can be
done about it — the endpoint declares `listChanged: false` so a client has no reason not to ask, and
that is the whole of what it can do. `update` prints the one step that is the operator's:
`lanes link mcp add`.

## What is unchanged

- **Connections are the workspace's** (ADR-057) — one authorisation per account, one credential
  store, `connections.yaml` untouched. This moves bytes, not accounts.
- **A grant names a connection** (ADR-058). No file's shape changes at contract 4.
- **`SINGLE_INSTANCE_PROVIDERS`** is unchanged. A prompt has no argument to route on and
  `vault.get.<id>` is a flat capability id, so `skills` and `vault` are still one per profile —
  which was always a per-profile constraint and reads more naturally now.
- **The owner layer still arrives granted** (ADR-050). A profile is created with every surface,
  and no `connect` step is suggested for one.
