# ADR-012: The owner layer's primitives, and how the vault is governed

**Status:** accepted, **§1 superseded in part by [ADR-014](014-owner-layer-is-managed.md) and
again by [ADR-030](030-a-profile-owns-its-skills-and-manifests.md)** ·
**Milestone:** M4 · **Extends [ADR-006](006-tools-resources-prompts.md)**

> §1's *location* — `<workspace>/skills/` — was reversed by ADR-030, which moves skills into
> `data/<profile>/skills.d/` on the grounds that "a procedure is not private to a profile" is not
> true of any procedure worth writing. The primitive argument below is untouched: a skill is
> still a prompt, still not a resource, and still routed by arguments.
>
> §1's conclusion that no capability may write a skill was reversed by ADR-014, which keeps the
> argument and replaces the answer: authoring is a capability in a non-default bundle, the way
> `memory.write` already was in §2 below. Reading a skill's body stays out of the read bundle, so the
> self-selection argument in §1 survives. §2 and §3 are unchanged — in particular "a write cannot
> hand itself a read" is still true of the vault, and ADR-014 says so explicitly because it gave the
> registry a `replace` that would break it if ever pointed at the vault.

ADR-010 was claimed by the connector kinds for IMAP and DAV, which landed first. This is the owner
layer's number.

## Context

`docs/detailed/init.md` names two questions to settle before building memory, skills, and vault, and the
vault turned up a third. All three are answered here because each one decides code that is hard to
change afterwards: an agent that has learned a tool name, a URI, or a policy rule does not unlearn
it.

---

## 1. Skills are invoked, so they are prompts

**Decision: a skill is a `PromptCapability`. It is not a resource, and it is not a tool.**

The discriminator is not "can you read it" — you can read anything. It is **whether the answer
depends on arguments**. A resource is a function of its URI alone; that is what makes it cacheable
and addressable. "Review this diff" is a function of the diff. So a skill is not a resource.

Against a tool: a tool result comes back to the model as *data it is reasoning about*. A prompt comes
back as *messages that become the conversation*. A procedure wants the second — and the difference is
not cosmetic. Instructions that shape what an agent does next should arrive as turns the client
chose to insert, not smuggled inside a tool result the model was told to treat as content from an
untrusted service.

**The property that decides it:** MCP clients surface prompts as user-selected — a slash command, a
menu — rather than something a model picks for itself. That reads as a limitation and is in fact the
point. A skill an agent selects for itself is an agent choosing its own instructions; a skill the
owner selects is the owner choosing. Under the injection argument in §2, that asymmetry is worth
more than the convenience of self-selection.

**Consequences.**

- Skills are authored **as files in `<workspace>/skills/`**, the way custom providers are files in
  `<workspace>/providers/`. *(Both directories moved into the profile in ADR-030; the analogy
  between them survived the move.)* There is no `skills.write` capability, and there should not
  be: a skill
  *is* instructions, so an agent that could write one could author its own future behaviour and
  persist it. That is §2's problem in its sharpest form, and the answer is that the write path never
  existed rather than that it is default-denied.
- Skills are therefore fixed for the life of the process. Adding one is editing a file and
  restarting, which is the same shape as adding a provider.
- A skill is **not** also exposed as a resource. Offering the body for reading would hand back
  exactly the self-selection the prompt primitive withholds.

Routing goes in the arguments — ADR-001 — because a prompt, unlike a resource, has arguments to put
it in. `profile` and `connection` are injected as *optional* and default when there is only one
candidate. Requiring a person choosing a slash command to type two routing strings to reach their
only account would be a poor trade for consistency, and the handler still refuses rather than guesses
when the choice is genuinely ambiguous.

---

## 2. `memory.write` is a separate capability, because writable memory persists injections

**Decision: reading and writing memory are different capability ids, in different bundles.**

Upstream content is already treated as potentially prompt-injecting and passed through unscreened —
`https://lanes.sh/docs/link/security` says so. Memory an agent can *write to* changes the shape of that risk rather than
its size: an injected instruction is stored once and re-served to **every future session, including
to a different agent**. A read-only memory cannot do this. Nothing else in the system has this
property, because nothing else persists model-authored text and serves it back as context.

So `memory.write` and `memory.forget` are their own ids, and a read-only agent is a real
configuration: `deny: [memory.write, memory.forget]`, one line.

**What this does not deliver, stated plainly.** `lanes link connect <provider>` writes `allow:
['<provider>.*']` into your config — a documented convenience (`packages/core/src/config/schema.ts`),
visible and editable, not a behaviour of the policy engine. So connecting memory grants writing too,
and "default-denied" is true of the *engine* (nothing is reachable unless a rule grants it) but not
of the file `connect` writes for you. Narrowing it is a deny line or a second profile. Making
`connect` grant less is a change to the connect flow, not to the owner layer, and is deliberately not
made here.

Nothing screens what is written. This ADR separates the privilege; it does not detect an injection,
and no part of this codebase claims to.

---

## 3. The vault: the item id is part of the capability name

**Decision: each vault item gets its own read capability, `vault.get.<item>`. Policy is not taught
about arguments.**

`docs/detailed/init.md` asks for per-item policy. `capabilityMatches` handles exactly `*`, `provider.*`, and
an exact match, and `PolicyRequest` carries no arguments at all. Two ways forward:

| | |
|---|---|
| **Item id in the capability name** | `vault.get.github_token` is already a legal pattern, already matches literally, and `vault.get.*` already narrows. Zero change to the policy engine. |
| **Argument-aware matching** | `schema.ts` says: *"Do not build a policy expression language beyond that."* |

The first, and the warning against the second is the reason. A policy language that can reason about
arguments is a language with its own bugs, and a bug in policy evaluation is the one bug this project
cannot afford — every other control assumes this module's answer is binding.

**What falls out of it, and why it is a feature.** Capabilities are fixed for the life of a process,
so the item list is read from the vault store when the runtime is built. An item created by
`vault.put` is therefore **not readable until the endpoint restarts**. That is not a workaround being
excused: it means a write cannot hand itself a read, and granting access to a new secret is a
deliberate act by the operator between two runs.

Discovery filtering does the rest. Because only permitted capabilities are registered, an agent
granted `vault.get.github_token` cannot see that `vault.get.bank_password` exists. There is no
`vault.list`, deliberately — the policy-filtered tool list *is* the listing, and it is the only one
that cannot over-report.

**Tools only, never resources**, per `https://lanes.sh/docs/link/capabilities`: resources are listable and cacheable, and
both are wrong for secrets.

**A separate store and a separate key.** Never `CredentialStore`. Credentials authorise *the system*
— if an agent could read the Gmail refresh token it would call Google directly and the whole policy
layer would be decorative. Vault items are the owner's own data, which an agent may legitimately be
granted. The test asserting the boundary was written in M1, before the vault existed, on purpose.

**Redaction.** `keepKeys` was the only builder, and it reduces every unkept value to a type marker —
`<string:40>`, which discloses a secret's length. `redaction({ keep, withhold })` was added for this:
the item id is recorded verbatim, because a log that cannot say *which* item was written answers
very little, and the value records `<withheld>` and nothing else. Redaction resolves before the
policy decision, so a denied vault call is redacted exactly like an allowed one.

**Amendment (0.8.0): a search query is the question, not the answer, and it is kept.**
`memory.search` withheld its `query`, on the argument that a memory query is at least as revealing as
a Gmail search query. That is true, and it is an argument about the wrong thing. A search term is not
the owner's material; it is what an *agent* went looking for in that material, which is the question
the log exists to answer. Withheld, every search read alike: memory was searched, twice, and matched
nothing, with no way to tell a calendar lookup from a rummage through someone's medical notes.

The pairing is what makes this safe rather than a loosening. The question is recorded and the answer
is not: `entry` keeps a `uri`, `get` keeps an `id`, `write` keeps `id`, `title` and `tags`, and no
capability on this provider keeps a body. A reader of the log learns what was asked and still cannot
learn what came back.

The old rule was reasoning about [`audit/fanout.ts`](../../../src/audit/fanout.ts): a workspace may
declare secondary sinks, and copies sent to stdout or an OTLP collector leave the machine. That
exposure is real and it is the operator's to weigh, which is exactly what declaring a sink is. It was
never a reason to withhold from the durable log on the operator's own disk, where the only reader is
the person the entries are about.

---

## What M4 had to change in core, contradicting `docs/detailed/init.md`

`docs/detailed/init.md` claimed **"Nothing in core changes to add them,"** and called that claim the real test
of the M1 architecture. It was false, and the honest result is more useful than a quiet edit. What
had to change, and why none of it is about memory, skills, or vault specifically:

| Where | What was wrong |
|---|---|
| `packages/connectors/src/local.ts` | `discover()` filtered to `isTool`, dropping every resource and prompt; `invoke()` threw `"is not a tool"` for anything else. |
| `packages/mcp/src/index.ts` | The resource path dispatched into that throw; it passed the URI as a string, so the SDK took the static overload and the placeholder was never expanded; and it substituted the literal token `{key}`, so any provider naming its variable anything else got no routing in its URI at all. There was no `resources/list` and no prompts branch. |
| `packages/core/src/dispatch.ts` | `DispatchOutcome` knew only `ToolResult`. |
| `packages/provider-sdk` | `redact` lived on `ToolCapability`, so a resource read could not declare what survives into the audit log. |

The verdict this supports: **the M1 *architecture* held — one dispatch path, one policy evaluation,
one audit event, and the owner providers are ordinary `defineLocalProvider` registrations. What had
not been built was the resource and prompt plumbing.** Two capability kinds had types, a registration
site, and no runtime. That is a different failure from a wrong shape, and cheaper to fix — but it is
not "nothing changes", and `example://note/{key}` had been unreadable since M1 without a test to say
so.

One gap remains and is recorded rather than hidden. A call naming a capability the principal cannot
reach is refused by the SDK before dispatch runs, so it would leave no audit trace;
`apps/server/src/index.ts` catches that for `tools/call` and — added here, since the name shape is
identical — for `prompts/get`. It cannot for `resources/read`, where the protocol mirrors the URI
rather than a name into the header: recovering a capability id from a concrete URI means matching it
against every registered template, and deciding what to record when it matches none. That is a
design decision M4 did not take. `apps/server/src/resources.test.ts` asserts the gap.
