# ADR-011: the `fs` connector, and why the cloud answer is a relay

**Status:** accepted (the `fs` kind). The relay is **designed, not built** — it belongs with M3.
**Extends [ADR-010](010-non-http-connectors.md).**

## Context

Apple exposes no protocol for iCloud Drive. Not a gated one, as with Mail's
OAuth; none at all. CloudKit Web Services reaches an application's *own*
container, and iCloud document storage gives an app an app-specific directory —
neither is the user's Drive.

What Apple does expose is a **folder**. On a Mac, iCloud Drive is
`~/Library/Mobile Documents/com~apple~CloudDocs`, kept in sync by the system, and
any process with the operating system's permission can read and write it.

So the honest framing is not "iCloud Drive has an API we lack access to". It is
"iCloud Drive is a local directory, and the question is which machine we are on".

### What the permission actually is

A distinction worth getting right, because it decides the architecture.

**Security-scoped bookmarks** are the *sandboxed app* mechanism: an App Store app
persists a user's folder grant across launches. `lanes-link` is not sandboxed, so
it needs no bookmark — it needs a **TCC grant**, which macOS holds against the
binary (or the terminal that launched it), keyed to that machine.

Either way the conclusion is the same and it is the important one: **there is no
credential.** Nothing is issued, so nothing can be stored, and nothing can be
carried to a Linux box. This is categorically unlike every other provider here,
where the whole design is "hold a token, use it from anywhere".

## Decision

A connector kind **`fs`**: a directory, `auth: none`.

Vendor-neutral like the rest — iCloud Drive is a manifest pointing at a path, and
the same connector serves Dropbox, a Syncthing share, or a project folder. It
passes ADR-010's test: protocol code, not vendor code. There is one iCloud-shaped
concession, `.icloud` placeholder detection, and it is discussed below.

### Confinement is the whole security story

Every other connector's blast radius is bounded by a credential's scope. This one
is bounded by a path check, and on a Mac with "Desktop & Documents" syncing into
iCloud Drive, the configured root is very nearly everything its owner has.

`confine()` therefore resolves the **real** path — following symlinks — before
comparing against the root, because a symlink inside the root pointing at
`~/.ssh` is otherwise an ordinary-looking folder. A path that does not exist yet
is checked against its nearest existing ancestor, so a *write* is confined too.
Absolute and `~`-relative paths are refused outright rather than resolved, since
accepting them would make the root advisory.

`.git`, `.ssh`, `.gnupg`, `node_modules`, and `.Trash` are refused regardless of
manifest — a repository in a synced folder holds credentials in its config and
the history of everything else.

### Nothing deletes permanently

Consistent with mail: `trash_file` moves to the system Trash and there is no
unlink. An agent that can permanently destroy a file is a different risk class
from one that can tidy up, and the Finder's Trash is a recovery path everybody
already knows. If the Trash is on another volume the rename fails, and refusing
beats falling back to a real delete.

### Eviction is reported, not stumbled over

With "Optimise Mac Storage" on, a file that has not been opened recently is
replaced by a hidden `.name.icloud` placeholder and the bytes live only in the
cloud. Reading that placeholder returns a few hundred bytes of plist — which
reads as a *corrupt* file rather than an absent one. So `read_file` detects it and
says the file is not downloaded and how to fetch it, and `file_info` reports
`downloaded: false` rather than claiming the file is missing.

## The cloud answer: a relay, not a stored token

This is the part that is designed and not built.

A cloud instance cannot serve `fs`. There is no token to give it, and inventing
one is not a matter of effort — Apple issues nothing that would work. The shape
that does work is a **local executor reached over an authenticated channel**:

```
agent → Lanes Link (cloud) → authenticated channel → Lanes Link (this Mac) → files
```

Google, Notion, and Linear continue to execute in the cloud instance, because
their credentials are portable by design. Apple-shaped capabilities execute where
the permission lives. The same channel would extend to anything else that is
machine-bound, and there is more of it than Drive: Reminders and Notes are
unreachable over any protocol but *are* reachable through local macOS APIs, so a
relay is also the only route to those.

Deliberately not built yet, for one reason: a relay is an inbound path into
someone's laptop, and it needs its own decisions — how the cloud instance
authenticates to the desktop rather than the reverse, what the desktop refuses
even when asked nicely, whether policy is evaluated at both ends or only one, and
what happens to an in-flight call when the laptop closes. Those are M3's
questions, alongside Cloud Run itself, and answering them badly to ship Drive
sooner would be the wrong trade.

Until then `fs` runs on the machine with the files, which is the local endpoint
this project already is.

## Consequences

- No new dependencies. It is `node:fs`.
- `lanes link connect icloud_drive` needs no prompt, no browser, and no
  credential. It also needs no *terminal* — a provider with `auth: none` and no
  account to name is no longer asked which account it is, which had made an
  otherwise scriptable connect interactive.
- Reading a file requires whatever TCC grant the launching process has. Run from
  a terminal that has been granted Files and Folders access, or Full Disk Access;
  otherwise the read fails with the operating system's own error.
- The `fs` kind is not iCloud-specific and will happily point at `~/`. That is a
  loaded gun and the manifest is where it is aimed; the built-in points at iCloud
  Drive, and a custom one is the operator's decision to make deliberately.
