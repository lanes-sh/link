# ADR-001: Connection identity is a tool argument

**Status:** accepted, extended by [ADR-009](009-one-endpoint-per-workspace.md) · **Milestone:** M1

> **Extended in M2.** `profile` is injected alongside `connection` by the same reasoning: one
> endpoint serves every profile, and namespacing tools per profile would multiply the tool list
> again for exactly the reason rejected below. Capabilities merge, so two mailboxes in different
> profiles remain one tool.

## Decision

Connection identity is a required tool *argument*, never part of the tool name.

- Tool: `gmail.search` (wire name `gmail_search`)
- Required argument: `connection`, an enum populated per profile from resolved policy

## Rejected: dynamically namespaced tools

`gmail.main.search`, `gmail.side.search`, and so on. The target setup reaches roughly ten
connections, which would produce fifty or more near-duplicate tool definitions. That harms
discoverability, bloats every tool list an agent has to reason about, and strains client
compatibility. One tool set per provider scales to any number of accounts.

## Consequences

**Providers never see routing.** A provider declares only its own arguments. Core injects
`connection`, resolves it to a `ConnectionInfo`, and hands the provider a context already scoped to
that account. A provider that declared its own `connection` argument would shadow the injected one,
so `providers/example` has a test asserting none does.

**The enum is the discovery filter.** It is built from the same `evaluate()` the dispatcher uses, so
a client cannot discover a connection it has no grant for, and discovery cannot drift from
enforcement. If they were computed separately they could disagree, and a leak in discovery is still
a leak.

**Wire names are transliterated.** MCP restricts tool names to `[A-Za-z0-9_-]`, so `gmail.search`
becomes `gmail_search` on the wire. The dotted form stays canonical in config, policy rules, and
audit records — that is what an operator reads and writes.

Since M2 a capability name may itself be dotted, because an OpenAPI operationId is
(`gmail.users.drafts.send` → `gmail_users_drafts_send`), so the mapping is no longer reversible by
splitting on the first `_`. Recovery consults the known capability ids first and falls back to the
split. That matters only on the refusal path — but a log entry saying an agent tried
`gmail.users_drafts_send`, which names nothing, is worse than useless.
