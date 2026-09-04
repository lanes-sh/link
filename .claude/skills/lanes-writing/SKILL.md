---
name: lanes-writing
description: Use when writing or editing any Lanes documentation, README, marketing copy, doc page, use case, comparison, or release post. Sets the register per page type, the test a sentence has to pass to stay, and the standing house rules.
---

# Writing for Lanes

Canonical copy lives in `lanes-sh/web` at `.claude/skills/lanes-writing/SKILL.md`.
The copies in `lanes-sh/link` and `lanes-sh/core` follow it; edit the canonical one.

## The reader

One person, in a hurry, who wants the thing running. They did not come to admire the
architecture. Every sentence between them and a working setup is a cost, and the only
justification for that cost is that the sentence saves them more than it spends.

## Step 1: pick the register

Three registers. Which one a page gets depends on what success means for its reader.

| Register | Reader's success | Shape |
|---|---|---|
| **Quickstart** | "It is running." | Prerequisite line, numbered commands, one line of result, one link out. Reasoning goes in a `Notes` block at the foot |
| **Layered** | "I understand this well enough to decide." | What it is, what you do about it, then why it works this way. In that order, never interleaved |
| **Site voice** | "I know whether this is for me." | A claim, then the proof. Benefit-first subheads, second person, short paragraphs |

Look the page up rather than deciding by feel:

| Page type | Register |
|---|---|
| Quickstart, install, connect, deploy, "add it to your agent" | Quickstart |
| Per-feature how-to (worktrees, loops, gateway, sessions, issue board) | Quickstart, plus one sentence on a step with a real gotcha |
| Concept and explainer (architecture, security, scopes, identity, capabilities) | Layered |
| Reference (commands, settings, shortcuts, providers, errors, API) | Tables only. One row per thing, no prose between rows |
| README, first screen | Site voice |
| README, everything below install | Quickstart |
| Index and overview (`/docs`, `/docs/mcp`, `src/content/pages/*.md`) | Site voice |
| Use case, comparison | Site voice |
| Blog | Leave the voice alone. Correct facts only |
| Terms, privacy, GDPR, cookies | Plain legal English. Accuracy beats brevity. No register change |

## Step 2: apply the sentence test

Read every sentence and ask what it does for the reader. It stays only if it does one of:

1. Tells them what to type or click.
2. Changes what they would type or click: a prerequisite, a default, a gotcha.
3. Tells them whether the page is for them.
4. Prevents a specific mistake that costs real time.

Everything else moves to `Notes`, moves behind a link, or goes. **The default answer is: it
goes.** A sentence that is true, well written and interesting still goes if it does none of
the four.

The legal documents get a fifth reason: it is a commitment or a disclosure the document has
to make. Nothing else does.

### What the test catches

| Cut | Why |
|---|---|
| The history of a rename | Nobody typing the new name needs the old one |
| A flag that is already the default | `--workspace local` when local is the default |
| An edge case affecting few readers | Move it to `Notes`; do not put it mid-procedure |
| Restating what the UI labels | If the dialog says "Working directory", the doc does not list the fields |
| A second link to the same place | One "next" per page |
| The mechanism behind a result | "Your agents can reach it" beats "the endpoint reconciles its manifest" |

## Step 3: the standing rules

- **No em dashes.** Anywhere. Use a comma, a full stop, a colon, or a hyphen.
- **Sentence case headings.** "Connect an account", not "Connect An Account".
- **Second person.** "You", never "the user".
- **Imperative headings on procedures.** "Install it", not "Installation".
- **One idea per sentence.** A semicolon joining two clauses is two sentences, or it is one.
- **Drop default flags from examples.** Show the shortest command that works.
- **One "next" per page.** A menu of five is a page that has not decided.
- **Counts that rot become ranges.** "Over a hundred providers", never "105", and never a list
  of five in a document that has to stay true.
- **Name the result, not the mechanism.**
- **Numbered sections are numbered once.** Check the sequence before you commit.
- **Every claim is checkable.** If you cannot point at the code, the doc does not say it.

## The `Notes` block

The escape hatch that makes cutting safe. Reasoning, edge cases and history that would
otherwise interrupt a procedure go under a `## Notes` heading at the foot of the page, one
bolded lead-in per note:

```markdown
## Notes

**Why the sign-in.** A profile declares who may use it, and the endpoint cannot check that
against anything if it does not know who is asking. The network is needed to sign in and to
refresh, not per call.

**If `lanes` is not on your PATH.** Several commands read your token with
`$(lanes link token show --raw)`, which substitutes to an empty string. The symptom is a 401
that looks like a bad token.
```

Nothing is lost. It is just no longer standing between the reader and step 4.

## Worked example

The Lanes Link README quickstart. Before, 230 words plus two "Why" paragraphs, every command
carrying a flag that is already the default:

```markdown
## Quickstart

Needs [Bun](https://bun.com) 1.3.11+, and a Lanes sign-in.

$ bun install -g @lanes-sh/link                # puts `lanes` on your PATH
$ lanes auth login                             # opens a browser once
$ lanes link profile add personal --workspace local
$ lanes link profile members add --me --profile personal --workspace local
$ lanes link start --workspace local

**Why the sign-in.** A profile declares who may consume it, and there is nothing to check
that against if the endpoint has no idea who is asking. That is a real dependency for a
self-hostable tool and worth stating plainly; what it is not is a dependency per request...

**Why `mcp add` names no profile.** One endpoint serves every profile in the workspace...
```

After, 62 words, with both "Why" paragraphs moved to `Notes`:

```markdown
## Quickstart

Needs Bun 1.3.11+.

$ bun install -g @lanes-sh/link
$ lanes auth login
$ lanes link profile add personal
$ lanes link profile members add --me --profile personal
$ lanes link start
ok  serving http://127.0.0.1:7337/mcp

In a second shell, point every installed agent at it:

$ lanes link mcp add

Your memory, tasks, files and skills work now. Mail and calendar are next:
`lanes link connect gmail`.

**[Full quickstart](https://lanes.sh/docs/link/quickstart)**
```

## Before you call it done

- Every heading is sentence case, and numbered sequences are numbered once.
- No em dashes.
- Every command is the shortest form that works.
- Every sentence passes the test in step 2.
- One "next" at the foot.
- Every internal link resolves to a page that exists.
