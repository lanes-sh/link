# ADR-051: A task and a file are each their own store, not a memory entry

**Status:** accepted · **Follows from** [ADR-012](012-owner-layer-primitives.md) ·
**Relates to** [ADR-014](014-owner-layer-is-managed.md),
[ADR-017](017-attachments-by-reference.md), [ADR-006](006-tools-resources-prompts.md)

## Context

Two things were being written into memory that it is the wrong store for, and in both cases the
write succeeded, which is why it kept happening.

**A thing to do.** "Remember to chase the invoice" became a memory entry. Entries are facts; facts
do not finish; nothing ever closed it. Worse than untidy — the entry is served back to every later
session as something that is *true*, so the invoice is still being chased six months after it was
paid. Memory has no field that could say otherwise, and adding one would make every entry a
half-task.

**A file.** Memory holds Markdown. A PDF, an image, an export had nowhere to live but the owner's
own filesystem — which on any target other than `local` the endpoint cannot reach, so the answer
was that there was no answer. The workaround available was base64 into a memory entry, which is
the thing ADR-017 exists to prevent.

## Decision

**Two more owner-layer providers, `tasks` and `assets`**, dividing the owner's material by what a
thing *is*:

| | Holds | Distinguishing property |
|---|---|---|
| `memory` | what is true | no state — a fact does not finish |
| `tasks` | what is to be done | a status, so it can be closed |
| `assets` | a file | bytes, under a name |

Both are ordinary `defineLocalProvider` registrations with a default `read` bundle and a
non-default `write` one, for the reason ADR-012 §2 gives for memory: text an agent authors is
stored once and re-served to every later session. A task list is a smaller version of that risk
rather than a different one — an injected "task" is an instruction with a due date.

### Tasks

Memory's storage shape unchanged: one Markdown file per task, metadata in frontmatter, no index,
and a tolerant parse so a file the owner drops in by hand reads as an open task rather than
breaking the listing that would have shown it. ADR-014 reversed the index-plus-body split for
memory and there is no argument for reintroducing it here.

Six statuses, and each earns its place by being a different answer to "why is this not done":
`in_progress`, `open`, `blocked` (waiting on something that is not the owner), `muted` (a decision
to stop being reminded), `done`, `dropped` (decided against, which is not the same fact as
finished). `blocked` and `muted` look adjacent and are not: one is the world's doing, the other is
the owner's.

`tasks.list` shows the first three and hides the rest. The question is almost always what is
outstanding, and a list that only grows is one nobody reads.

There is no `tasks.complete`. `update` covers it, and `tools.test.ts` holds a per-tool schema
budget that a wider surface spends for nothing.

### Assets

**The key is the filename.** `invoice-2026-03.pdf` is stored at
`assets/<connection>/invoice-2026-03.pdf`, and that is the whole layout — no id, no prefix, no
sidecar, no index. `BlobStore.list()` already reports size and mtime and the content type follows
from the extension, so every fact a listing needs is either the key or something the store already
had. It is the same reversal ADR-014 made, pushed one step further: a sidecar holding an asset's
name would be a second name for a file that already has one.

The cost is that an asset carries no description, and that is deliberate. "The March invoice is in
assets as invoice-2026-03.pdf" is a memory entry. Prose in a store with no way to search it would
be worse than either.

**Writes name a source; reads return text or nothing.** `assets.store` takes one of the five
sources `resolveAttachments` already resolves, which is ADR-017 reused rather than restated — and
buys the size ceiling, the two-sources-named refusal, and the SHA-256 receipt with it. A read is
the same rule outward: `ResourceContents` carries text and nothing else, so a text asset comes
back as text and a binary one comes back *described* — name, type, size, digest. A 239 KB PDF is
roughly 320,000 characters of base64; there is no reason to refuse that inbound and pay it
outbound.

### `tasks` is the built-in; Google Tasks is `google_tasks`

The id was taken. `buildRegistry` registers the owner layer before looping over `PROVIDERS`, so an
owner provider called `tasks` throws `Provider "tasks" is already registered` at startup while a
manifest holds that id — the rename is forced, not cosmetic.

It is also the right way round. `tasks` is the owner's own list, which is what someone means by the
word; `google_tasks` is an account, and the `_`-qualified form is what `gmail_imap`, `drive_mcp`
and the `icloud_*` family already use for a surface that needs saying which one.

**The migration is a refusal, in `assertReferentialIntegrity`.** A profile that ran
`connect tasks` holds `provider: tasks`, which now resolves to the built-in — reconcile marks it
active, because a provider needing no credential is authorized by construction, and the operator
is left with their Google Tasks tools gone and a task list labelled with their email address.
Nothing errors. The tell is the account: a built-in row is written in exactly one spelling,
`account: Tasks`, while `connect tasks` recorded the address the operator typed, because Google
Tasks publishes no identity to read one from. So an `@` there means the vendor surface, and the
message names the fix.

Deliberately not keyed on the connection id. Several task lists in one profile is a legitimate
thing to want, exactly as several memory connections are, so `id !== 'main'` would refuse a valid
profile forever to catch a one-release migration.

The rename also lengthened every redaction key, and that is worth recording because it fails
silently. `shortenName` strips the *provider id* from a discovered tool name and Google namespaces
its operations under the *API* name; while the id was `tasks` those were the same string, so
`tasks.tasks.patch` shortened to `tasks.patch`. With the id `google_tasks` nothing is stripped, and
a redaction key that misses does not error — it withholds every argument and reads exactly like
working redaction. `contacts` has looked this way since it shipped (id `contacts`, operations
`people.people.*`), so the long form is the existing shape and the short keys were a coincidence
of the old id. Teaching the transport to strip an API prefix was rejected: that is vendor
knowledge in `connectivity/`, which `architecture.test.ts` exists to keep out.

## Why not one wider memory

Considered: keep one store and add a `status` field, plus a `kind: file` variant. Rejected on both
halves. Every entry would carry a status that means nothing for most of them, so "what is
outstanding" becomes a query over things that were never tasks; and a store whose documents are
sometimes Markdown and sometimes bytes cannot have one read path, so `memory.get` would have to
grow the text-or-described branch and every caller would have to handle it. Three stores that each
answer one question beat one that answers three partially.

## Consequences

Getting an asset into a mail is **not** offered here. `stageAttachment` scopes a handle to
`<provider>/<connection>`, so one minted under `assets/main` is deliberately unresolvable from
`gmail/main` — bridging that crosses the isolation every provider relies on and belongs in
`#dispatch` if it belongs anywhere. `lanes link attach <file> --connection <provider>.<account>`
already prints a handle the mail tools accept, and the refusal text says so.

An asset name may not end `.meta` or `.tmp`. The filesystem adapter writes `<key>.meta` beside a
blob whose content type its extension cannot express, `<key>.tmp` mid-write, and skips both in
`list()` — so an asset called `report.meta` would be stored, never listed, and readable only by
someone who already knew the name. Memory never met this because every key it writes ends `.md`;
an asset's key is whatever the file was called.

Neither joins the `knowledge:` block. ADR-041 scopes that to memory and skills and says nothing
else may go there; tasks could reasonably follow later, and binaries in a git repository is its own
question.

The `initialize` instructions gained the routing rule and the budget went from 2500 to 2700 — see
`#server/mcp`'s `MAX_INSTRUCTIONS`, which records the arithmetic. Memory and tasks share one
paragraph when both are reachable, because the mistake is a routing one and is shorter said once;
the substitution is conditional, because prose describing a tool the list does not carry is worse
than absent prose.
