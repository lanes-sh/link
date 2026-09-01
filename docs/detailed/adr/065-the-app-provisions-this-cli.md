# ADR-065: The desktop app installs and updates this CLI on its own lifecycle

**Status:** accepted · **Amends** [ADR-034](034-updating-is-a-reinstall.md) · **Follows from**
[ADR-053](053-the-page-a-person-reads-is-the-app.md)

## Context

ADR-034 ends with a sentence that was true when it was written: *nothing updates itself, and
nothing blocks on asking*. Three commands print a line when a newer release is out, `update`
performs the install, and a person types it.

ADR-053 then put a Lanes Link page in the desktop app, and recorded the symmetry that came with
it: the app installs this CLI from its settings page, with a button. That button runs
`bun install -g @lanes-sh/link` — the install this repository documents, unchanged — and a second
button runs `lanes link update`.

What was left is the gap between installing the app and having the CLI. Somebody who installs
Lanes gets a settings page telling them to install a second thing, and somebody whose app updates
itself keeps whatever CLI they had. Both are answered by the buttons already there; neither is
answered by anything that presses them.

Nothing about *how* an install happens changes here. The commands are the same commands, Bun is
still the only installer driven, and a machine the app provisioned is indistinguishable from one
where a person typed the line themselves. What changes is who decides when.

## Decision

**The app runs those two commands on its own lifecycle.** Installing the app installs this CLI;
updating the app updates it. The trigger is one persisted string — the app version the app last
provisioned for — compared at launch. Absent means a fresh install, stale means the app has been
updated since, equal means nothing happens. It is not a poll: asking once per launch is the whole
schedule, and an interval would be a watchdog reinstalling a CLI somebody chose to remove.

**A foreign install is replaced rather than argued with.** ADR-034 describes the split-install case
— `npm i -g` is not prevented, Bun installs to its own prefix, and PATH order decides which
answers — and has `update` detect and report it. The app does not stop at reporting: where it can
name the uninstall (`npm`, `pnpm`, `yarn`), it removes that copy and installs with Bun, so exactly
one remains. Where it cannot name one, it leaves the copy alone and falls back to `update`.

**The app runs this CLI from the home directory.** `update` without `--check` also runs the
contract migration and the owner-layer repair, against whichever workspace `resolveWorkspaceRoot`
finds — and that walk starts at the cwd. A packaged app has cwd `/` and lands on `~/.lanes-link`
by luck rather than by intent. The app names home explicitly so that an unasked-for migration can
never land on a project workspace that happened to be above the cwd.

**A checkout stays refused, and that is what protects a contributor.** The app asks
`update --check --json` first and does nothing on a `checkout` verdict, so a machine running
`bun link` against a tree is left alone by exactly the rule ADR-034 already wrote for it.

**This repository does not change.** No flag, no new field, no non-interactive mode: every command
the app drives was already non-interactive and already emits the JSON it reads. The code is in the
desktop app, and this record exists because the sentence it makes untrue is here.

## What this costs, stated plainly

An install now happens on a machine without anyone having asked for it in that moment. That is a
real thing to give up and it is worth naming rather than describing as convenience.

Three things bound it. It is gated on the app's Auto-Update setting, which is the same switch that
already lets the app replace itself — one switch, one meaning. It runs in a terminal the person can
open and read from the sidebar, rather than as a hidden subprocess. And it can only ever run the
two commands this repository documents; there is no third thing it is permitted to install, and
where neither Bun nor Homebrew is present there is no command to run and it does nothing.

What it does not get is a prompt. A first-run dialog was the alternative and it was declined:
installing the app is the consent, and a modal asking whether Lanes may install the thing Lanes is
for is a question with one answer.

## Consequences

`update`'s own report is now sometimes read by a machine rather than a person, which costs nothing
because `--check --json` was already built for that (ADR-034) and already never fails a command.

A person who removes the CLI deliberately is not fought with. The stamp is already written for the
running app version, so nothing reinstalls it until the app next updates — at which point it
returns. That is the honest consequence of tying this to the app's lifecycle rather than to a
watchdog, and the settings page is where somebody who wants it gone for good turns Auto-Update off.

The nudge in `start`, `doctor` and `deploy` stays exactly as it was. It addresses the person in
front of a terminal, which is a different reader from the app, and on a machine the app keeps
current it will simply have nothing to say.

## What this does not do

It does not make the app a package manager. It installs one package, by name, with the command
this repository documents.

It does not pin a version. The app installs whatever `latest` is, the same as a person would;
there is no compatibility matrix between an app version and a CLI version, and deliberately no
version sniffing in either direction.

It does not restart a running endpoint. ADR-034 already says an update leaves one serving the old
code until it is restarted, and that is still true — with the difference that the app knows how to
start one and can say so.
