# ADR-016: what the endpoint says about itself, and what we write into a client

**Status:** accepted · **Milestone:** M6 · **Narrows the "we do not write an agent's files" rule
stated in `mcp.ts`, `outputs.ts`, and `profile.ts`**

## Context

`lanes link mcp add` registered the endpoint and stopped. What a client then held was sixty tools
with good individual descriptions and no account of what they were collectively for: that memory is
worth searching before answering from nothing, that a skill is the owner's own procedure rather
than a suggestion, that `profile` is a boundary and not a setting. Every one of those is a habit,
and a habit does not fit in a tool description.

The material to fix it already existed — `skills/lanes-link/SKILL.md` — and nothing installed it.
`lanes link mcp skill` printed a path and a `cp -r` for the operator to run, on the reasoning that
*where an agent keeps its skills is the agent's business*. In practice that meant the document was
read by nobody.

---

## 1. Delegate where the harness owns a command; write the file where it does not

**Decision: `lanes link mcp add` installs the agent skill. Registration is still delegated.**

The existing rule was stated three times in the codebase and is kept, narrowed to what it was
actually protecting. Its argument was never about file ownership in general — it was that a
registration *format* is the harness's to define, so writing one ourselves means guessing at a
schema that can change under us. That is why `mcp add` shells out to `claude mcp add` and
`codex mcp add`: if either changes, we break loudly instead of writing something stale.

There is no `claude skill add`. Nothing exists to delegate to, so the choice is not "delegate or
write" but "write, or do not ship it". And the two risks are not the same size:

| | Getting it wrong means |
|---|---|
| Registration | a config file we corrupted, in a format we invented |
| A skill | a Markdown document in a directory named `lanes-link/` |

**What keeps this honest** is that the target is ours by name. `~/.claude/skills/lanes-link/` is not
a shared file we are appending to — it is a directory this project is named in, so overwriting it is
not a surprise, and someone who wants their own version writes their own skill under their own name.
The one thing deliberately *not* done here is writing into `AGENTS.md` or any other shared document,
which would need markers, a merge, and a way to be wrong about someone else's content.

**Consequences.**

- `--no-skill` registers and writes nothing, for anyone who wants the old behaviour.
- Re-running refreshes the document, which is the point: an upgrade should not require the operator
  to notice that the skill changed. It compares before writing, so a second run reports `unchanged`
  and does not touch the file's mtime — a harness watching its skills directory would otherwise
  reload on every `mcp add`.
- `lanes link mcp list` reports the document's state beside the registration, because there are two
  ways to be half set up and they have different fixes.
- `lanes link mcp skill` stays, and gains `--print`. It is the answer for every client with nowhere
  to install a file.

## 2. The endpoint describes itself, and that description is generated

**Decision: `buildMcpServer` sets MCP's `instructions`, computed from resolved policy.**

A skill file reaches Claude Code and Codex. It does not reach Claude Desktop, Cowork, Cursor, or
anything else that takes a URL and nothing more — and those clients are exactly the ones with no
other channel. `instructions` is delivered in the `initialize` response to every client that
connects, at no cost to the operator, so it carries the part that must arrive everywhere and the
bundled skill carries the longer form.

**Generated rather than written, because the interesting half is per-workspace.** "Ask which profile
is meant" is advice; "you are serving `personal` and `work`, and these are the accounts in each" is
the fact that makes it actionable. It is computed from the same `mergeCapabilities` result the tools
are registered from — one policy evaluation, two consumers — so it describes exactly what the caller
can reach and cannot drift from it. Over HTTP the server is rebuilt per request, so it cannot go
stale either.

**What this costs, stated plainly.** It is in the system prompt of every session against this
endpoint, so a paragraph added here is paid for on every request forever. `instructions.test.ts`
holds a length budget for that reason, and the right response to needing more room is usually to put
the paragraph in the skill, where it is loaded only when relevant.

Two smaller constraints fall out of where the code lives. `server/` is inside the architecture
test's vendor scope, so the fixed prose can name no provider — which is correct independently, since
the list is whatever this owner has connected. And the string is built in code rather than read from
`instructions/`, because `.dockerignore` keeps that directory out of the image and a deployed
revision still has to describe itself.

## 3. One root for the documents, named for what they are

**Decision: bundled client-facing documents live under `instructions/`, not `skills/` and
`agents/`.**

A repository-root `skills/` claimed a word this project had already spent. `<workspace>/skills/` is
the owner's own procedures — `lanes link skills add`, served as MCP prompts — and `main.ts` already
described the collision between that and `lanes link mcp skill` as *"a trap worth closing"*. Two
directories called `skills`, meaning different things, in one repository, was the same trap one
level up.

`instructions/skills/` and `instructions/agents/` keep the kind explicit, because the installer maps
kind to a harness directory, while naming the category honestly: these are what we tell a client.
That is the same word as the MCP field in §2, and deliberately — the server's `instructions` and
these documents are three renderings of one brief, and a reader who notices the shared name has
understood something true rather than been confused by an accident.

This does not rename the commands. `lanes link skills` and `lanes link mcp skill` are still one
letter apart; closing that is a separate change with its own compatibility question.

---

## What this does not do

**Nothing here screens what a client does with any of it.** These documents shape behaviour by
being read, which is exactly the property that makes a prompt injection durable — and `docs/detailed/security.md`
already says upstream content is passed through unscreened. The difference is provenance: this text
ships in the repository and is reviewed like code, where a memory entry is model-authored. That is a
real difference and it is not a control.

**It does not make a subagent a boundary.** `instructions/agents/lanes-link-scout.md` tells the
scout to read and not write. What actually stops a write is `lanes link policy deny memory.write`.
The agent file says so itself rather than implying an isolation it cannot enforce.
