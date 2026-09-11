# ADR-078: A removal works on a config that will not load

**Status:** accepted · **Extends** [ADR-051](051-tasks-and-assets-are-their-own-stores.md) — "a
refusal at load has to name a command, and the command has to exist" — from repair to removal

## Context

`lanes link profile add my-profile` wrote `profiles/my-profile/profile.yaml` and then parsed it back.
The rule the name has to satisfy lives in the schema, so it was only ever enforced by that read — and
the read happens after the file exists. The command reported an error *and* left the profile behind.

The error was never the problem. The leftover was, because nothing in the tool could take it away:

```console
$ lanes link profile remove my-profile --workspace local --yes --delete-data
error  /tmp/repro/profiles/my-profile/profile.yaml:
  instance.profile: must be lowercase letters, digits, and underscores, starting with a letter
```

`profile remove` and `doctor --fix` both resolve the profile before acting and died on the same parse,
while `listProfiles` reads directory names rather than configs — so it stayed listed like any other
profile, and the only way out was deleting the file by hand, or the bucket object on a deployed
workspace. Issue #219.

The name guard that stops `profile add` creating one is a separate change and is already in. It does
not help the profiles already on disk, and it addresses one cause out of several: a hand edit, an
interrupted write, or a contract the installed version does not recognise all end in the same place.

ADR-051 has already had this argument once, about the other command:

> A refusal at load has to name a command, and the command has to exist.

There it made `doctor --fix` the route back from a config the loader refuses. The same sentence applies
to removal, and more sharply — being able to delete something broken is exactly when it matters most.

## Decision

**`profile remove` degrades rather than refusing, automatically, and reports what it could not see.**

No `--broken` or `--force` flag. The command an operator already reaches for is the one that has to
work; a flag would be a second thing to discover at the moment they are least able to. The gates that
were already there stay: `confirmedByName` still asks for the name, and the disposition question is
still asked.

### What makes it safe: a gap shrinks the plan, it can never widen it

Removal derives its credential refs from what the profile *declares*, then keeps only those the store
actually holds. So a field that could not be read contributes no ref, and the removal deletes less than
it might have — never something that was somebody else's. This is the property the whole design turns
on:

> What a config that will not load costs is a line that is missing, never one that is wrong.

`RemovalSubject` exists to keep it true. The four things `removalPlan` reads off a config are a type
rather than a docstring, so a fifth cannot be added without confronting the degraded reader beside it.

### The directory's name is authoritative

`layout.blobs(profile)` is what addresses the blob tree, so a hand-edited `instance.profile` reaching
it would let `profile remove my_profile` empty `profiles/other/`. Every key comes from the directory —
which is also what the operator typed and what `listProfiles` showed them. The file's own value is
needed for exactly one thing, the middle segment of `vault/<profile>/<connection>`, and where the two
disagree the ref is reported as unreachable rather than guessed at.

### One degraded path, not two

A `profile.yaml` refused by the schema but perfectly good as YAML — which is what #219 produces —
yields every field, so the plan is identical to a parsed one. Filing that under "partial removal" would
owe the operator an explanation that is not true. A file that will not parse as YAML is the same read
with nothing to read: every field lands unread and the same code runs.

### The decision point is structural, not a `catch`

`ConfigError` comes out of profile resolution for a missing `--workspace`, an undeclared target, a
pointer chain that will not follow, a contract-3 layout, and a profile that is simply not there — as
well as for the parse. A `try` around the whole resolution would read "you typed the wrong workspace"
as "this profile is broken", and `--yes --delete-data` would then run a removal to completion in a
workspace nobody meant.

`locateProfile` splits the resolution so only the parse is caught. `resolveSelection` never reads a
config — it asks the workspace whether the file exists — which is the property that makes the split
possible, and the one `migratedRenamedProviders` already relies on. `resolveProfileOnly` becomes three
lines on top of it, so there is one resolution path rather than two that can drift.

### Exit 0 iff nothing was left, not iff the config parsed

`renderOutcome`'s contract is already "a live credential left behind must not look like success to a
script". The trigger is *something is left*, never *something threw*. Keying the code on the parse gets
both halves wrong at once: the profile #219 produces reads every field and leaves nothing, so reporting
failure for it means the cleanup script that hit the bug still fails — on a profile that is now gone —
and it gives that the same code as a deployed profile that really did strand a sealed document. Two
states, one code, no information.

Where something *is* unreachable, the outcome says **"running this again will not find them: the
profile is gone"**. The existing exit-1 pairs with "fix the above and run the same command again",
which works only because a failure keeps the config — the record of where everything lives. Here there
is nothing left to re-derive from.

### `--migrate-to` is refused

Not because the mechanics fail: `migratesAcross` is a key-prefix test and `resolveCollisions` opens the
destination by name, and both work fine here. It is the asymmetry in what going wrong costs.
`--delete-data` fails toward having deleted less than it should, which is the direction everything else
here leans. `--migrate-to` fails toward putting bytes nobody could account for into a profile that is
currently correct, under a connection it may not grant — invisible to every command that reads it, and
with nothing to undo it. The refusal names the two ways forward, as every refusal in this command does.

## Consequences

**Three functions take a name where they took a `Config`.** `openStorage`, `recordConfigChange` and
`publishWorkspace` each read one thing off the parsed file — the profile's name, or nothing at all —
and requiring the whole of it is what stopped a removal opening the stores, writing the audit row, and
telling the endpoint. This is the narrowing `openSecrets` already made, for the reason its own docstring
gives: a caller that must work while the file on disk will not parse cannot be asked for the parsed
file. `targetInput()` keeps `profile` and `config.instance.profile` from drifting apart.

**The endpoint is still told, and it matters more here rather than less.** A config that will not load
*today* is not a profile that was never served: the served set is built at boot and at `/reload` and at
no other time, so a file that parsed at the last boot is being served right now, from memory, with live
credentials. The reload is the only thing that drops it before a restart.

**A salvaged config goes through `findSecrets` before anything is kept.** A parsed one has been through
that check on its raw object, deliberately and before the schema; without this the degraded path would
be the one route by which a config value reaches a terminal, an audit row and a `--json` document
unchecked.

**`doctor --fix` still refuses a profile it cannot parse.** Repairing one means rewriting
`instance.profile` or renaming its directory, which is a choice about the operator's data rather than a
deletion, and it is a separate argument. What has changed is that there is now a way out that does not
involve leaving the tool.

**Four files where there were two.** `subject.ts` is what a profile declares, `removal.ts` what a
removal deletes, `preview.ts` the plan an operator decides from, `perform.ts` the doing of it. The
budget in `architecture.test.ts` pointed at each split, and in each case it was pointing at two subjects
rather than at length.
