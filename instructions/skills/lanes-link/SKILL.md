---
name: lanes-link
description: Use when the user refers to their own accounts, knowledge, procedures, or secrets through Lanes Link — "check my mail", "what do I know about X", "remember this", "which profile am I in" — or asks to connect, register, or set up their Lanes Link MCP server with this agent. Also covers what to do when a Lanes Link call is refused, or when the endpoint is not running.
---

# Lanes Link

A self-hostable gateway to one person's own context: the accounts they have
connected, the knowledge they have accumulated, the procedures they have
written down, and their secrets. One endpoint serves every profile in a
workspace under one token, and each call names which profile it means.

The endpoint describes its own live state when you connect — which profiles
exist, what is reachable in each. This file is the part that does not change:
how to behave with it.

## Profiles are a boundary, not a setting

Every tool takes `profile` and `connection`. Profiles are how someone keeps work
and personal apart; they share no database and no credential store.

**Ask which profile is meant when it is ambiguous. Do not default to whichever
is listed first.** Quietly picking one crosses the line the profile exists to
draw. There is no "current profile" to switch — the choice is made per call, and
`lanes link profile list` shows what exists.

A `connection` names an account within that profile. One profile may hold
several of the same kind, and naming a connection belonging to a *different*
profile is refused rather than guessed at.

## Reach for memory before answering from nothing

`memory.search` before concluding you do not know something about this person or
their work. It is a substring search over their own notes, not a ranked index —
try more than one wording before deciding it is not there.

Writing is a separate grant, and it should be. What you write is served back to
every later session, including to a different agent, so **write when you are
asked to remember something, not as a habit.** The owner reaches the same
entries with `lanes link memory list` and a text editor.

## Skills are theirs, not yours

A skill is a procedure the owner wrote down. They arrive as prompts — slash
commands — and are selected by the person rather than chosen by the model. You
cannot read a skill's body; that is deliberate, not a gap to work around.

So when a task has a skill for it, **say the skill exists and let them invoke
it** rather than improvising your own version of their procedure. They manage
these with `lanes link skills list` and `lanes link skills show <name>`.

## Vault values are credentials

Use one to do the thing that needs it. Never quote it back, summarise it, echo
it into a file, or paste it into a command whose output you will show. If a
value has been printed by accident, say so.

## Attachments are named, not carried

Where a tool takes `attachments`, each entry names **one** source and the endpoint
reads the bytes itself. Naming two is refused rather than resolved.

```jsonc
{ "path": "/Users/them/Downloads/invoice.pdf" }         // on the endpoint's own machine
{ "url": "https://example.com/invoice.pdf" }            // fetched here, HTTPS only
{ "message_id": "18f…", "attachment_id": "quote.pdf" }  // already on a message in that mailbox
{ "handle": "att_01j7k…" }                              // staged out of band
{ "data": "JVBERi0…", "filename": "invoice.pdf" }       // base64, and a last resort
```

`attachment_id` takes a filename, a position, or the vendor's own id, and can be
omitted when the message has one attachment. `filename` and `content_type`
override what the source implies.

**Never encode a file into a call.** A 239 KB PDF is roughly 320,000 characters
of base64 — more than you can write in one message — and the way that fails is a
mail which mentions an attachment and does not have one. The other four sources
exist so you never have to.

**Forwarding something that arrived by mail is free.** Use `message_id` rather
than fetching the attachment and passing its bytes along. Reading them is not
offered anyway: the read tools report each attachment's name, type and size, not
its content.

**If the endpoint is not on the same machine as the file**, `path` names the
*server's* filesystem rather than theirs, and will not find it. Ask them to run
`lanes link attach <file> --connection <provider>.<account>`, which prints a
handle to use instead.

**`draft_only: true`** saves instead of sending, where they should see it before
it goes out.

Sent mail shows the account's own name when the connection sets `from_name`. If
something you sent arrived as a bare address, say so — it is a one-line config
fix, not a reason to write a signature into the body.

Every send records each attachment's filename, size, type and digest, and where
the bytes came from.

## A refusal is the system working

Only permitted capabilities are visible at all, so something missing was not
granted, and retrying will not reveal it. A call that *is* refused was refused by
policy on purpose.

Report it plainly and let the owner decide whether to widen the grant —
`lanes link policy list` shows the rules, `lanes link policy allow <capability>`
changes them, and that is their call, not yours. **Do not look for another route
to the same data.** Every call is audited either way; `lanes link audit tail`
shows what was attempted, refusals included.

## Setting something up

Call `setup_overview` before answering any question about what you can reach, and
before suggesting that anything be connected. It names the accounts reachable in a
profile and the providers that are not connected yet. `setup_provider` then gives
one provider's console steps, the values it will ask for, and the exact command.

**Take the command from `setup_provider`; never compose one yourself.** It carries
the right profile and, where the provider stores a credential per account, the
`--id` it needs. A command you assembled is one the owner pastes and watches fail.

You cannot do the setup. This endpoint writes no configuration and stores no
credential — those are `lanes link` in a terminal, deliberately. What you can do is
know exactly what to hand over, and say what it will ask for before they start.

If you have a shell, you can run it yourself for anything that does *not* need a
browser: `lanes link setup plan <provider> --json` lists what to store,
`lanes link secrets set <ref>` takes the value on stdin, and
`lanes link connect <provider> --id <name> --non-interactive --json` finishes.
Anything with a browser sign-in belongs to whoever owns the account — give them
the line.

**Never pass `--accept-broad-scopes` yourself.** When a provider asks for more than
it needs, print the scopes and let the owner add the flag. Deciding that is theirs.

A new connection is not served until the endpoint restarts, so a `setup_overview`
straight after connecting will still not show it. Say so rather than retrying.

## Registering it, and re-registering it

`lanes link mcp add` runs each harness's own registration command and installs
this skill where that harness keeps them. With no argument it does every harness
installed; name one (`claude`, `codex`) to be specific. Run it again after
`lanes link token rotate` — add `--force`, since Claude Code stores the token as
a value rather than a command.

**Never paste the token.** There is a right way and a wrong way, and the
difference matters:

```bash
# RIGHT — the token goes from the CLI to the harness. You never see it.
claude mcp add --transport http lanes-link http://127.0.0.1:7337/mcp \
  --header "Authorization: Bearer $(lanes link token show --raw)"

# WRONG — the token is now in your context, and in the transcript, forever.
lanes link token show --show          # then copying the value into the command
```

The token reaches every account of every profile the endpoint serves. Use the
substitution form. If you have already printed one by accident, say so and offer
`lanes link token rotate`.

Prefer `lanes link mcp add` to writing the command yourself: it checks the
endpoint is reachable, refuses to silently shadow an existing registration, and
cannot mistype the token. For a harness it does not know, take the command from
`lanes link outputs` rather than writing it blind — that command checks whether
`lanes` resolves on this machine and prints a longer working form if it does
not, where guessing gives you an empty substitution, a `Bearer ` header, and a
401 that reads as a bad token.

If you register Codex, tell the user to export the token — Codex stores only the
variable name, so nothing works until it is set:

```bash
export LANES_LINK_TOKEN="$(lanes link token show --raw)"
```

One registration covers every profile. Do not add one per profile; they share a
URL and a token.

## When it is not running

`lanes link start` runs in the foreground and serves until stopped. Tell the
user the command rather than backgrounding it silently on their behalf.
Registration works while it is down — the harness simply cannot reach it yet,
and the first symptom is a failed call much later.
