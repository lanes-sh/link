# ADR-061: A workspace is the only word, and a default may be sticky where nothing is destroyed

**Status:** accepted · **Completes** [ADR-052](052-a-target-owns-its-workspace.md) ·
**Amends** [ADR-037](037-a-command-names-what-it-acts-on.md),
[ADR-043](043-a-target-scoped-command-acts-on-the-target.md)

## Context

ADR-052 decided that a workspace *is* a target. It said so in those words, and the note appended
to ADR-009 says the two "now coincide exactly". What it did not do is finish the sentence: the
config key stayed `targets:`, the flag stayed `--target`, and `workspace` went on being used for
the directory in prose while `target` was used for the same thing in commands.

That is one concept with two names, which this repository treats as the defect everywhere else it
appears — two spellings of a reserved row, two sources for one adapter set, two answers to where a
target's bytes are. It survived because renaming is churn and the meanings had only just merged.

There is now a second reason to finish it. A remote workspace is about to be bound to a **Lanes**
workspace, which is what carries the members a profile delegates to ([ADR-060](060-a-caller-is-a-person.md)).
Three words for two things — target, workspace, Lanes workspace — is not a vocabulary anyone can
hold.

The second half of this decision is harder, because it reopens something that was argued and won.

ADR-037 removed every implicit selection and deleted `lanes link target use`, on reasoning worth
quoting rather than summarising:

> Persisted context state is the standard way operators run destructive commands against the wrong
> target, and the version of it that bites is the dotfile nothing prints.

That is correct about destructive commands. Applied to all of them it produces `lanes link status
--profile personal --workspace local` typed forty times a day, and a flag typed reflexively has
stopped being a guard — which is the same over-reach ADR-043 found and fixed for a different
reason.

## Decision

**`target` is retired as a word.** `targets:` becomes `workspaces:`; `--target` becomes
`--workspace`; `target list|show` become `workspace list|show`. The pointer key inside an entry
becomes `at:`, because `workspaces.<name>.workspace` names the concept twice and reads as a typo.

`--target` is accepted for one minor as a deprecated alias that warns on use. The desktop app
spells it in Rust argument arrays and in a persisted, serde-mirrored settings field, and cutting
it in the same release would break the app for anyone who updates the CLI first.

**`default_workspace` is read.** `lanes set-workspace <name>` writes it, and every command that
resolves a workspace prints which one it used and where the value came from:

```console
$ lanes link status
workspace  local  (default)
```

**The echo is the decision, not a nicety.** ADR-037's objection is precisely to "the dotfile
nothing prints", and a default that announces itself on every command is not that dotfile. If the
line is ever dropped for tidiness, this decision has been reversed.

**A command that publishes or destroys refuses the default.** `deploy`, `sync`, `secrets push`,
`profile remove`, `disconnect` and `token rotate` require `--workspace` to be typed, and say so:

```console
$ lanes link deploy
error  --workspace is required. This command publishes; the default is not
       used for commands that change something outside this machine.
```

That is the exact hazard ADR-037 names, kept, while the forty-times-a-day commands stop paying for
it.

**`connect` is deliberately not in that set.** It creates rather than destroys, it is the command
someone runs while learning the tool, and it prints the workspace it wrote to. Requiring a flag
there is the ceremony ADR-043 identified as the way a required flag stops being a guard.

## Why this is not the chain ADR-037 removed

The chain was `--profile`, then `LANES_LINK_PROFILE`, then `default_profile` — three sources, and
nothing on screen saying which had answered. This is **one** source, read only when the flag is
absent, printed every time, and refused outright by the commands that can do damage.
`LANES_LINK_TARGET` and `LANES_LINK_PROFILE` stay unread, and their refusal messages are retained.

The distinction is the same one ADR-052 drew for pointers: a single declaration followed to exactly
one place is not a resolution chain, however much it resembles one from a distance.

## What this costs, stated plainly

**Every command in a year of notes, scripts and documentation says `--target`.** The alias covers
the transition and then stops, which means it breaks later rather than never. The deprecation
warning names the release that removes it.

**A sticky default is a state someone can forget.** The echo bounds it and does not eliminate it:
somebody piping `--json` sees no banner, because the banner is not in the JSON. That is the honest
hole in this decision. `--json` output therefore carries the resolved workspace as a field, so the
answer is in the payload for anyone reading it programmatically.

**`profile add` and `profile remove` still name their profile positionally** and still reject
`--profile`. Nothing about the default reaches the profile axis: there is no `default_profile`,
it stays parsed and ignored, and this decision does not reopen it. A profile is the thing a
mistake is most expensive against.

## Consequences

**`workspace list` is the command you run to find out what `--workspace` accepts**, so it stays at
`'none'` and keeps working when every other command is failing — the reasoning ADR-052 gave for
`target list`, unchanged apart from the word.

**`lanes set-workspace` is a top-level command, not `lanes link set-workspace`.** It selects which
workspace *the* CLI acts in, and a second area added to `lanes` later will want the same answer.

**The refusal text changes shape.** ADR-043's "--target is required" listing every target in the
workspace becomes the same listing under the new word, and gains a line naming the default when
one is set and the command refused it anyway.
