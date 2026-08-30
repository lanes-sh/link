# ADR-006: Tools, resources, and prompts are decided per capability

**Status:** accepted · **Milestone:** M1

## Decision

Do not make everything a tool.

| Primitive | For | Example |
|---|---|---|
| **Tool** | actions and parameterised queries | `gmail.search`, `example.set_note` |
| **Resource** | read-oriented context addressed by a stable identifier | `example://note/{key}` |
| **Prompt** | reusable procedures | skills |

Decide per capability and record the reasoning in `https://lanes.sh/docs/link/capabilities`.

## Why this matters more than it looks

Making everything a tool is the easy default. It works, so the cost is invisible — until the owner
layer arrives, where **memory is resource-shaped** (retrieve by address, enumerate, cache) and
**skills are prompt-shaped** (a reusable procedure an agent invokes). Getting the distinction wrong
there means either a tool surface bloated with pseudo-resources, or a migration once agents already
depend on the names.

So the example provider exposes a `note` resource alongside its tools, deliberately, while the cost
of getting it wrong is nil. It is the smallest place to prove the mechanism works.

## The prompts primitive stays unused in M1

No M1 provider returns a prompt. `PromptCapability` is defined so its shape is fixed and nothing else
claims the primitive in the meantime. Reserving it costs nothing; reclaiming it later would not be
free.

## Resources and connection routing

A resource URI carries no argument to route on, so — unlike tools, where `connection` is an injected
argument (ADR-001) — a resource is registered once per reachable connection with the connection id in
the URI. Same policy filter, different mechanics, because the primitive has nowhere else to put it.
