# ADR-056: Everyone else is declared too, and a lookup answers with all of them

**Status:** accepted · **Follows from** [ADR-042](042-a-profile-declares-its-owner.md) ·
**Amends** [ADR-041](041-memory-and-skills-in-a-repository.md) ·
**Relates to** [ADR-050](050-the-owner-layer-is-granted-by-default.md),
[ADR-051](051-tasks-and-assets-are-their-own-stores.md),
[ADR-014](014-owner-layer-is-managed.md), [ADR-012](012-owner-layer-primitives.md)

## Context

ADR-042 exists because a profile said what was *reachable* and nothing about *whose* it was, so
an agent writing as the owner inferred a name from whatever was in the conversation. The fix was
to write it down.

The same failure happens one step outward and nothing catches it. Asked to "email Jan about the
invoice", an agent has no declared answer for who Jan is. It reaches for an address it saw in a
thread, or asks, or guesses — and the guess is not obviously a guess, because an address that
appeared in a mailbox this endpoint serves looks exactly like an address the owner uses for that
person.

The information is knowable. Nobody had written it down, because there was nowhere to write it.

Memory is the store people reach for and it is the wrong shape for this. "Jan's email is
jan@acme.test" written as a memory entry is findable only by substring, comes back as prose a
model has to parse, and says nothing about which of two addresses to prefer. It is the same
argument ADR-051 made for tasks and assets — the write succeeds, which is why it keeps happening —
applied to a third thing memory is not.

## Decision

**An eighth owner-layer provider, `entities`**, holding the people, companies, projects and
accounts the owner deals with. It is `identity`'s mirror: identity says who the owner is, this
says who everyone else is.

### One tool, and it never chooses

`entities.find` takes structured criteria — a query matched against ids, names, aliases and
attribute values; plus `type`, `tag`, `attr` and a one-hop `related` — and returns **every**
match.

Three outcomes, and **none of them is an error**:

| | What comes back |
|---|---|
| one match | the whole entity, with a resource link |
| several | all of them, ranked, showing only the fields that *differ* |
| none | what was tried, and not to invent an address |

An earlier draft refused on ambiguity: exactly one entity or an `isError` naming the candidates.
It was rejected, and the reason is that it models the wrong thing. An assistant handed two people
called Jan asks which one is meant; it does not fail. Several matches is a normal answer to a
reasonable question, and returning it as an error makes every honest ambiguity look like a
malfunction.

What survives from that draft is the part that mattered: **the tool never picks.** Three rules
carry it, because with no error there is nothing else standing between two candidates and an agent
using the first:

1. **Ordering is not selection.** Candidates are ranked so the list is legible — an exact id above
   a substring — and nothing presents the first as the answer. There is deliberately no scoring
   *inside* a rank: no most-recently-updated tiebreak that would quietly promote one of two exact
   alias matches. This is the thing a later contributor will be tempted to improve.
2. **The count comes first**, before any candidate, so a client that truncates the response has
   still seen that there was more than one.
3. **Several matches render what distinguishes them**, not two full records. Two Jans separated by
   their employer is a question the surrounding context usually settles; two rows of identical
   detail is not, and printing everything about both buries the one column that would have decided
   it. When nothing distinguishes them the answer says so — that is a duplicate to merge, not a
   choice to make.

Exact matches suppress prefix and substring ones. That is a boundary between *kinds* of match, not
a precedence among equals: two exact alias matches both survive and both are returned.

A tag is never matched by the query. A tag is a category, not an identity, and `find("client")`
returning one of eleven clients as if it were a name is the failure this component exists to
prevent, wearing a different hat.

### The model

One entity is one Markdown file with YAML frontmatter — memory's shape exactly (ADR-014), so the
directory stays one a person can open, edit and review.

```yaml
type: person
name: Jan Bakker
aliases: [Jan, JB]
attributes:
  - { kind: email, value: jan@acme.test, note: work }
  - { kind: email, value: j.bakker@example.net, note: personal }
relations:
  - { predicate: works_at, entity: acme-bv, note: since 2023 }
```

**`attributes` is a list, not a map**, and the argument is identity's verbatim: a map cannot say
*when* to use which, and the note is the whole point. A map also silently forbids two email
addresses, which is the case that matters most. Order is preference order, so the first of a kind
is the default — the same rule an agent already learned from `identity_list`, which is why the two
shapes are deliberately the same.

`type` and `predicate` are free-form. A closed vocabulary would need a release every time somebody
wants `vessel` or `depends_on`, and identity refused an enum for the same reason.

**Relations are one-sided.** An edge is written into the entity that declares it and nowhere else;
the reverse is derived when the catalogue is built. Writing both sides is two files for one fact,
and nothing in this codebase locks — an interrupted write would leave a half-edge that nothing
detects. A dangling edge is legal and renders as a plain name: an entity referred to before it is
declared is a fact the owner recorded, and hiding it would make the graph quietly wrong rather
than visibly incomplete.

`forget` does not cascade, for the same reason: a delete that rewrote five other people's files
could not be reviewed as one change. It reports who still points at what it removed.

### It is writable, and identity is not

These look inconsistent and are not. ADR-007 makes identity CLI-only because an agent able to edit
it could edit the one fact that stops it signing as the wrong person. Everyone else's details are
ordinary owner material that accumulates in conversation, on the same surface that reads it — so
`entities` follows `memory`: a default `read` bundle and a non-default `write` one (ADR-012 §2).

The same distinction settles the default grant. `entities` is in `DEFAULT_SURFACES` and `identity`
is not, and ADR-050's test is not "is it empty" — memory arrives empty and is granted — it is
**can it be filled in from here**. Identity is configuration; a surface reporting an empty one
could never do anything about it. Entities can.

A note on the risk, because it is not quite memory's. ADR-012 §2 says text an agent authors is
re-served to every later session. An entity is worse than re-served: it is *acted on*. An injected
address is used to send something.

### A derived index, stamped with what it was built from

A read that opened every entity file is fine on a local directory and is a thousand HTTPS GETs
against a bucket or a knowledge repository. So `_index.json` sits beside the entity files holding
what a lookup needs, and a read that finds it valid opens no entity file at all.

It is a **cache**, not a second source of truth, which is the distinction ADR-014 removed memory's
index for failing. What makes this one different is that it carries a fingerprint of the exact
listing it was built from: a file edited in an editor or on GitHub invalidates it structurally
rather than by anybody remembering to. Absent, truncated, wrong-version and mismatched are one
case, and all four rebuild from the files without throwing — `openRuntime` treats a corrupt
discovery cache the same way, and never as a reason to fail startup.

The fingerprint is `key:size`, not `key:size:mtime` as `skillFingerprint` uses. That one is a
change detector for a two-second poll, where a false positive costs a reload; this is a validity
stamp, where a false positive costs a full rebuild and, on a knowledge repository, a commit. The
GitHub adapter reports the *branch tip* as `modifiedAt` for every file, so on the one backend where
the index is worth the most, an mtime-bearing fingerprint would never match twice. Dropping mtime
also lets a writer compute the fingerprint of the state it is about to create, since it knows the
byte length before the put — no second listing, no read-back.

**No read ever writes the index.** A read that finds it stale rebuilds in memory and serves the
right answer; only the three write capabilities and `entities reindex` persist. So no read can
move a branch tip, and therefore no read can invalidate the next read.

**The hole this leaves, stated rather than hidden.** A hand-edited *index* whose fingerprint still
matches untouched entity files is served. The fingerprint stamps the documents, not itself. It is
pinned by a test, and closed where it matters: a single match — the only shape that gets acted on —
is re-read from its file, and any disagreement rebuilds the whole catalogue and re-runs the search
rather than patching the one row. Patching would answer with an entity that no longer matches what
was asked for, and "here is your one result" is exactly the wrong sentence then. Re-running can
legitimately return none, or several, and both are better than a confident wrong answer.

## What this amends

ADR-041 is titled "memory and skills may live in a repository, **and nothing else may**". Entity
files may too.

That exclusion was never a count. Its argument is a discriminator: an artefact of one installation
stays, a document the owner wrote may move. State, the audit log, the credential store and the
vault are excluded *structurally* — there is no field in `knowledgeTargetSchema` that could name
them — and this amendment adds none. An entity file is a Markdown document with frontmatter,
hand-editable, wanting history and review, reachable from more than one machine. It is on the same
side of that line as a memory entry, by the same test, and "nothing else may" was a statement about
what existed rather than about what qualifies.

The derived index travels with the entity files, because it is derived from what travels. That is
the weaker half of this argument and is worth saying plainly: it is a cache landing in a documents
repository, it churns in every commit that changes an entity, and it is there only so a fresh clone
does not pay a full rebuild on its first read.

## Consequences

**Where this stops being the right design.** Steady state on a bucket is one listing and one GET
whatever the entity count, because a listing carries key and size only. A rebuild is one read per
entity.

| entities | listing requests | index | steady-state read | rebuild |
|---|---|---|---|---|
| 100 | 1 | ~35 KB | 2 requests | 100 GETs |
| 1,000 | 1–2 | ~340 KB | 3 requests | 1,000 GETs |
| 10,000 | 11 | ~3.4 MB | 12 requests | 10,000 GETs |

A thousand is comfortably inside the design. Ten thousand is where it is the wrong design, and the
answer then is not a larger index but a validity check that needs no listing — which needs an
adapter reporting a per-object etag, and `BlobMetadata` carries none. On a local directory, which
is what most people run, neither the index nor anything else here is worth a measurable amount.

**Every write rewrites the whole index.** ~340 KB at a thousand entities. Unremarkable against a
bucket; on a knowledge repository it is a blob in every commit. A bulk load of two hundred entities
through two hundred calls rewrites it two hundred times, and `entities reindex` after the fact is
the documented answer. A `--defer-index` flag was considered and rejected: a flag that leaves the
index stale when a run fails is worse than the cost it avoids.

**`MAX_INSTRUCTIONS` rises to 2900**, the fourth raise, certified at 2800 rather than guessed. The
paragraph earns it on ADR-042's argument restated: an agent that resolves "email Jan" to the wrong
address has already sent the message, before a skill would have loaded, and the client most in need
of the rule is the one holding no skills directory. It also carries a rule nothing else can
enforce — `find` sets no error on several matches, so between two candidates and a message sent to
the wrong person there is only prose. It collapses with `IDENTITY` when both are reachable, on
`MEMORY_AND_TASKS`'s argument, which is worth 161 characters as well as being the clearer sentence.

**`RESERVED_PROVIDER_IDS` is eight**, and `entities` is appended rather than inserted
alphabetically so it lands beside `identity` — the order is read, and the two collapse.

**Multi-hop traversal is not in this decision.** `related` is one hop and free, because backlinks
are derived anyway. Nothing in the storage or the schema precludes adding depth later, which is why
the vocabulary was left free-form.
