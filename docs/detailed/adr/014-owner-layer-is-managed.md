# ADR-014: the owner layer is managed — a write path for skills, one storage shape for all three

**Status:** accepted · **Milestone:** M5 · **Supersedes [ADR-012](012-owner-layer-primitives.md) §1
in part**, and closes a gap ADR-012 did not see.

## Context

M4 built memory, skills, and vault, and left them unreachable except through an agent. There was no
`lanes link memory`, no `lanes link vault`, no `lanes link skills`. To put a password in the vault you asked a language model
to type it. To add a skill you edited a file and restarted the endpoint. To reach a memory entry you
had to be an MCP client.

`docs/detailed/workflow.md` — which `docs/detailed/init.md` calls *"the normative CLI user experience"* — has no command
for any of the three, and never did. This was not a regression: the control plane for the owner layer
was specified nowhere and so was never built.

The gap is sharpest where the layer's own principles collide. The README says *"control-plane
decisions are not agent-reachable"*, and the owner layer inverted it: the two stores holding the
owner's own data were reachable **only** by an agent, while the one thing that shapes agent
behaviour — a skill — was reachable only by a human with a text editor and a restart.

---

## 1. A skill can be written, by the CLI and by an agent

**Decision: `skills.manage.{list,get,write,remove}` exist, in a non-default bundle. ADR-012 §1's
"the write path never existed rather than being default-denied" no longer holds.**

ADR-012 §1 argued: a skill *is* instructions, so an agent able to author one could author its own
future behaviour and persist it. That argument is correct and is not withdrawn. What is withdrawn is
the conclusion that the only safe answer is structural absence.

**The same risk already has a different answer three files away.** ADR-012 §2 faced it for memory —
model-authored text, stored once, re-served to every later session including to a different agent —
and answered with a separate capability id in a non-default bundle. Two providers with the same
threat and opposite conclusions is not a security posture; it is an inconsistency that had to resolve
one way or the other.

It resolves toward the grant, for a reason that is about honesty rather than convenience. Structural
absence *reads* stronger than it is. A skill file is writable by anything running as the owner —
another agent with filesystem access, a shell command, a `lanes-link` process — so "no agent can write
a skill" was only ever "no agent can write a skill *through this endpoint*", while the endpoint is
the one path that evaluates policy and writes an audit event. Moving authoring inside the boundary
makes it governable: `deny: [skills.manage.*]` is one line, and every write is recorded with the
skill's name.

**What is preserved, and is the part worth keeping:**

- **Authoring is not in the default bundle.** Same shape as `memory.write`. And the same caveat, said
  as plainly as ADR-012 §2 said it: `lanes link connect skills` writes `allow: ['skills.*']` into your file,
  so connecting skills grants authoring too. Narrowing it is a `deny` line or a second profile. That
  is a property of what `connect` writes for you, not of the policy engine.
- **Reading a skill's body is in the *author* bundle, not the read one.** This is the sharper half of
  ADR-012 §1 and it survives intact. MCP clients surface prompts as user-selected — a slash command
  rather than something a model picks for itself — and a `skills.manage.get` in the read bundle would
  hand back exactly the self-selection the primitive withholds. An agent that can invoke skills still
  cannot read what they say, so it cannot browse the catalogue for instructions to give itself.
- **Nothing screens what is written.** As with memory: this separates the privilege. It does not
  detect an injection, and no part of this codebase claims to.

**The management tools are namespaced `manage.`** because a skill named `write` would otherwise be
the capability `skills.write` twice over. A skill name cannot contain a dot, so `skills.manage.*` can
only ever mean these four.

### The consequence: skills reload without a restart

ADR-012 §1 accepted that skills are *"fixed for the life of the process"*. That was tolerable when
adding one meant an operator editing a file. It is not tolerable when a granted agent can write one
and then find that the prompt does not exist.

So `ProviderRegistry` gains `replace`, and the endpoint re-reads its skills before serving a request.
Two triggers: a write through MCP refreshes directly, and a poll bounded to one `list()` per profile
per two seconds catches a skill written by `lanes link skills add` in another terminal. The listing is the
change check as well as the source — `BlobMetadata` carries size and mtime — so a poll that finds
nothing costs one listing and no reads.

**`replace` is not a general hot-reload facility, and the vault must not use it.** Replacing a
provider mid-flight changes what policy is evaluated against between one call and the next, so the
only safe subject is a provider whose capabilities are pure data. ADR-012 §3's *"a write cannot hand
itself a read"* is untouched: a `vault.put` item is still unreadable until the next start, and
`apps/server/src/owner.test.ts` now says explicitly that this is what the refresh must leave alone.

---

## 2. One storage shape, and the vault finally has a deployment

**Decision: memory, skills, and vault all go through `BlobStore` and follow the target. A memory
entry is one Markdown file. The vault's document I/O is pluggable; its format is not.**

Three providers had three ideas about where bytes go, and one of them was a bug.

**The bug.** `openRuntime` built `createFileVaultStore` unconditionally — no target switch, unlike
credentials, database, and blob storage, which all have cloud adapters. On Cloud Run, where
`LANES_LINK_HOME` is `/app` and the disk is ephemeral, every vault item was written to a filesystem
the next revision discarded. Silently. This is the failure ADR-013 fixed for blobs, still present for
the one store holding the owner's passwords.

`targets.<t>.vault` now selects `file` or `blob`, optional and defaulting to `file` so every profile
written before this keeps working. Skills follow the target for the same class of reason: a
filesystem path is baked into a container image at build time, so a deployed instance could only ever
serve the skills that existed when its image was built.

**There is no secret-manager adapter**, and that is a decision rather than an omission. The vault
encrypts the whole document as one, so item *names* are encrypted alongside their values — a property
ADR-012 §3 chose deliberately. A secret-per-item mapping would publish those names into a cloud IAM
console to buy nothing this does not already have. And ADR-013 makes Supabase the one documented
cloud host, which has no secret manager, so a Secret-Manager-only vault would have no cloud story
there at all.

The blob adapter **will not mint a key.** The file adapter may, because it has a sibling `.key` file
at 0600 that outlives the process. A deployment has no equivalent: a key written beside the
ciphertext it protects encrypts nothing, and a fresh key per revision would make every previously
stored item permanently unreadable while appearing to work. So `LANES_LINK_VAULT_KEY` is required
there, and its absence is an error naming `lanes link vault key generate` rather than a silently empty vault.

### Memory is one file, and the index row is gone

The index — id, title, tags, size, timestamp — was a state row beside a body blob. It bought a
listing that did not have to read every body, and it cost three things: the two could disagree, an
entry could not be opened in an editor, and a Markdown file written by hand was not an entry at all.

Metadata now lives in YAML frontmatter above the body, in the format a skill already uses, and the
whole entry is one object. Listing and search read every entry and say so in the audit annotation.
That is the honest cost, and it replaces a scan that `memory.ts` already documented as a full one —
`StateRepository` has no prefix query and no index either.

Frontmatter is **optional on read**. A plain Markdown file dropped into the directory reads as an
entry titled after its id, rather than becoming an error that hides every other entry behind it. The
directory is one a person is invited to open; a parser that refuses their file is a parser that makes
the invitation false.

---

## 3. The CLI reaches the same bytes

**Decision: `lanes link memory`, `lanes link skills`, and `lanes link vault` are control-plane commands over the same stores
the providers use.**

Not a second implementation of the storage layout — `Runtime` exposes the skills store and the vault
store, and memory's key and document format are exported from the provider. Two spellings of one
layout is exactly how a control plane and its data plane drift apart.

This does not widen ADR-007. Its exclusion list is policy, tokens, credentials, connections, config,
and audit — the things that authorise *future agent behaviour*. Vault items and memory entries are
the owner's own data, which ADR-012 §3 already says an agent may legitimately be granted. Skills are
the interesting case, and they are now reachable from **both** sides deliberately: the CLI because it
is the owner's own control plane, and MCP because §1 above decided the grant is a better answer than
the absence.

`lanes link vault get` prints a value, which `lanes link secrets` deliberately never does. That difference is the
two-kinds-of-secret distinction (`docs/detailed/security.md`) doing its job: a credential authorises the
system and is never disclosed; a vault item is the owner's own password, and a vault they cannot read
without an agent is not a vault.

---

## What this costs, stated plainly

- **A granted agent can now write instructions it will later be handed.** Policy is the only thing
  between it and that, and `lanes link connect skills` grants it by default. This is the same trade
  `memory.write` has carried since M4, now made twice.
- **Listing memory reads every entry.** Fine at owner scale, and worse than an index at any other. If
  it ever needs to serve tens of thousands, the answer is a derived cache that can be rebuilt from
  the files — never a second source of truth.
- **A skill can change under a running endpoint.** Bounded to a two-second poll and to the skills
  provider, but it is a mutable surface where there was none, and `replace` is a method that would be
  wrong to reach for again without revisiting this.
