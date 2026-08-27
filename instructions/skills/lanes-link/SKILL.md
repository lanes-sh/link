---
name: lanes-link
description: Use when the user refers to their own accounts, knowledge, procedures, or secrets through Lanes Link — "check my mail", "what do I know about X", "remember this", "which profile am I in" — or asks to connect, register, or set up their Lanes Link MCP server with this agent. Also covers operating the workspace from a shell — adding or removing a profile, checking what a target serves, deploying an endpoint or recovering a lost deployment — and what to do when a Lanes Link call is refused, or when the endpoint is not running.
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

**What a command must be told is never inferred — but it is not always both.**
Nothing resolves from an environment variable or a config default, so a command
missing what it needs refuses rather than acting somewhere else. Passing a flag a
command does not read is refused too, which makes "add both to be safe" its own
failure. Four levels:

- **Neither.** `lanes link profile list`, `lanes link mcp list`,
  `lanes link version`.
- **`--profile` alone.** `lanes link check`, `lanes link config show`,
  `lanes link policy list`, `lanes link target list --profile <name>`,
  `lanes link identity list`. Each is target-independent — one declaration in the
  YAML that applies wherever the profile runs.
- **`--target`, with the profiles derived from it.** `lanes link status`,
  `lanes link deploy` and `lanes link sync targets` act on one endpoint serving
  every profile that declares that target. `--profile` is accepted and *narrows*
  the answer; it does not choose the subject.
- **Both.** Everything acting on one account: `lanes link connect`,
  `lanes link token rotate`, `lanes link secrets set`, `lanes link policy allow`,
  `lanes link memory list`, `lanes link mcp add`.

`lanes link profile add` and `lanes link profile remove` **reject** `--profile`.
Both name their profile positionally, so a flag naming a second one could only
disagree with it.

When you write a command out for the owner, fill in what that command needs or
leave it as `<name>` for them to complete — never drop a required one.

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
entries with `lanes link memory list --profile <name> --target <name>` and a text editor.

## Skills are theirs, not yours

A skill is a procedure the owner wrote down. They arrive as prompts — slash
commands — and are selected by the person rather than chosen by the model. You
cannot read a skill's body; that is deliberate, not a gap to work around.

So when a task has a skill for it, **say the skill exists and let them invoke
it** rather than improvising your own version of their procedure. They manage
these with `lanes link skills list --profile <name> --target <name>` and `lanes link skills show <skill> --profile <name> --target <name>`.

## Vault values are credentials

Use one to do the thing that needs it. Never quote it back, summarise it, echo
it into a file, or paste it into a command whose output you will show. If a
value has been printed by accident, say so.

## Who you are writing as is declared, not inferred

A profile may declare the names, addresses and handles its owner wants used when
something is written as them. Call `identity_list` for the profile in play
before signing a message, choosing an address to send from, or attributing work
to a handle — **do not** read a name off the conversation, off a previous
message's signature, or off the account label on a connection. That label is the
identity a provider reports for a mailbox; it is not necessarily what they sign
with.

A profile may declare several of a kind on purpose. The first is the default and
each carries a note saying when to prefer it, so read the notes rather than
picking the first unconditionally. If none of them fits what you are doing, ask
— do not combine two, and do not carry one profile's name into another. That
crossing is the specific mistake this exists to prevent.

If the tool is not there, the profile has declared nothing. Ask rather than
inventing something; they add one with `lanes link identity add <kind> <value> --profile <profile>
--target <target>` — both flags, because neither has a fallback.
Nothing you can call writes here, deliberately.

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
`lanes link attach <file> --profile <name> --target <name> --connection <provider>.<account>`, which prints a
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
`lanes link policy list --profile <name>` shows the rules, `lanes link policy allow <capability> --profile <name> --target <name>`
changes them, and that is their call, not yours. **Do not look for another route
to the same data.** Every call is audited either way; `lanes link audit tail --profile <name> --target <name>`
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
browser: `lanes link setup plan <provider> --profile <name> --target <name> --json` lists what to store,
`lanes link secrets set <ref> --profile <name> --target <name>` takes the value on stdin, and
`lanes link connect <provider> --profile <name> --target <name> --id <id> --non-interactive --json` finishes.
Anything with a browser sign-in belongs to whoever owns the account — give them
the line.

**Never pass `--accept-broad-scopes` yourself.** When a provider asks for more than
it needs, print the scopes and let the owner add the flag. Deciding that is theirs.

**A new connection is served at once; the tools you were handed are not.**
Connecting publishes the config to wherever that target's endpoint reads it and
asks the endpoint to re-read it, so a `setup_overview` straight after connecting
*does* show the account. What has not changed is the set of tools this session
was given when it connected — the endpoint does not announce that its tools
changed, so a capability for a freshly connected account is not callable until
the client reconnects. Say that, rather than reporting the connection as missing
or asking them to connect again.

One exception, and it is the one that matters here: the authenticator is built
once at boot and is not re-read, so a `lanes link token rotate` does need the
endpoint restarted before the new token opens anything.

## Operating the workspace

If you have a shell, the commands that only *read* are yours to run without
asking: `lanes link status`, `lanes link check`, `lanes link plan`,
`lanes link doctor`, `lanes link profile list`, `lanes link target list`,
`lanes link target show`, `lanes link tools`, `lanes link config show` and
`lanes link audit tail`. None writes config, opens a browser, or costs anything,
and running one beats asking the owner to paste its output back. Give each what
its own level requires — they are not all the same, and the four levels are at
the top of this file.

**A command that writes runs `--dry-run` first, where it has one.** Show what it
reported and wait for an answer. `lanes link deploy`, `lanes link sync targets`,
`lanes link profile remove`, `lanes link secrets push` and `lanes link mcp add`
all take it. For a write with no dry run — `lanes link token rotate`,
`lanes link policy allow`, `lanes link secrets set` — say in one sentence what it
will change, then let them decide. Never a browser sign-in: that belongs to
whoever owns the account, as above.

**`--json` is not everywhere.** It parses on every command and is read by only
some, so one that ignores it prints its ordinary output and gives you nothing to
key on — do not treat the absence of JSON as a failure. `status`, `doctor`,
`tools`, `outputs`, `sync targets`, `target list`, `target show`, `profile list`,
`connect` and `setup plan` implement it. `deploy`, `check`, `plan`,
`config show`, `audit tail` and every `mcp` subcommand do not.

**A profile is created and removed, never switched.** `lanes link profile add
<name>` writes a new one and takes `--target <name>`, repeated once per target it
should declare. `lanes link profile remove <name>` takes `--dry-run` and then
`--yes`; given a `--target` it decommissions that one target's stores and leaves
the profile file in place. Neither reads `--profile`.

There is no current profile and no default target. `lanes link profile default`
and `lanes link target use` are gone and now refuse with an explanation — if you
meet one of those refusals, it is not a broken install, and there is no
replacement to find. The choice is made per command, on purpose.

## Deploying, and what it decides

`lanes link deploy` builds an image and rolls a revision. Its subject is a
**target**, and the profiles behind it are every profile declaring that target,
so one deploy serves all of them — there is no per-profile deploy to run and no
reason to loop over them.

**Always `--dry-run` first, and show what it printed.** It creates cloud
resources that cost money, it implements no `--json` to inspect instead, and that
plan is the only place the consequences are visible while they are still
avoidable.

Two things it refuses to guess, and both are the owner's to answer:

- **Whose bearer token opens the endpoint.** One token reaches every profile
  behind that target, so this decides who gets in. With several candidates and
  nothing recorded, it refuses and prints the command that names one.
- **A first deploy.** A target no profile declares yet has no set to derive from,
  so `--profile` is required there. It may be repeated, and the first one named
  is the primary.

**Never pass `--yes`, `--non-interactive`, `--access public` or
`--service-account` yourself.** Each settles a question about who can reach their
accounts. Print what the flag would decide and let them add it — the same rule
this file already applies to `--accept-broad-scopes`.

Deploying is how new code reaches the endpoint. It is not how an account gets
connected and not how a config change lands; both of those publish themselves.

## When the workspace and the endpoint disagree

A deployment records where it lives, and a workspace can lose that record — a new
machine, a reinstall, a profile file restored from something older. The endpoint
is still serving; what went missing is the config that describes it. The symptom
is a `lanes link status` that reports nothing deployed for a target you know is
up.

`lanes link sync targets` reconciles the two. `--discover` looks for a deployment
the workspace has no record of, `--from <location>` names one directly, and
`--dry-run` reports what it would merge without merging it. Run the dry run and
show it.

**`--prefer local` or `--prefer remote` is their answer, not yours.** It decides
which side wins where the two disagree, and the losing value is the one nobody
was asked about. Report what differs and let them pick.

## Registering it, and re-registering it

`lanes link mcp add --profile <name> --target <name>` runs each harness's own registration command and installs
this skill where that harness keeps them. With no argument it does every harness
installed; name one (`claude`, `codex`) to be specific. Run it again after
`lanes link token rotate --profile <name> --target <name>` — add `--force`, since Claude Code stores the token as
a value rather than a command.

**Never paste the token.** There is a right way and a wrong way, and the
difference matters:

```bash
# RIGHT — the token goes from the CLI to the harness. You never see it.
claude mcp add --transport http lanes-link http://127.0.0.1:7337/mcp \
  --header "Authorization: Bearer $(lanes link token show --raw --profile <name> --target <name>)"

# WRONG — the token is now in your context, and in the transcript, forever.
lanes link token show --show          # then copying the value into the command
```

The token reaches every account of every profile the endpoint serves. Use the
substitution form. If you have already printed one by accident, say so and offer
`lanes link token rotate --profile <name> --target <name>`.

Prefer `lanes link mcp add --profile <name> --target <name>` to writing the command yourself: it checks the
endpoint is reachable, refuses to silently shadow an existing registration, and
cannot mistype the token. For a harness it does not know, take the command from
`lanes link outputs --profile <name> --target <name>` rather than writing it blind — that command checks whether
`lanes` resolves on this machine and prints a longer working form if it does
not, where guessing gives you an empty substitution, a `Bearer ` header, and a
401 that reads as a bad token.

If you register Codex, tell the user to export the token — Codex stores only the
variable name, so nothing works until it is set:

```bash
export LANES_LINK_TOKEN="$(lanes link token show --raw --profile <name> --target <name>)"
```

One registration covers every profile. Do not add one per profile; they share a
URL and a token.

`lanes link mcp list` needs neither flag and reports whether the registration and
this document are current, out of date, or absent. That is the cheap first
question when behaviour does not match what this file describes — an out-of-date
copy means the rules you are reading are not the ones that shipped.

Claude Desktop cannot be handed a URL, so it spawns the endpoint over stdio
instead. That one is named in the client's own config file rather than registered
by a command, as `lanes link mcp stdio --profile <name> --target <name>`; both
flags are required, and nothing may be written to stdout.

## When it is not running

`lanes link start --profile <name> --target <name>` runs in the foreground and
serves until stopped. Tell the
user the command rather than backgrounding it silently on their behalf.
Registration works while it is down — the harness simply cannot reach it yet,
and the first symptom is a failed call much later.

## When a call does not land

Different from the above, and more common: calls were working, and then one does
not go through. A deployed endpoint is one machine its owner runs, and a client
can report it unreachable while it is up — sometimes without sending anything at
all, which is why the endpoint's own log can show no trace of the attempt.

Treat it as ordinary. **Say the call did not land, and stop there.** It is not a
fault to diagnose, and it is not authorization that has lapsed — do not tell them
to sign in again unless the endpoint itself said so.

**Do not redo what already succeeded.** A call that returned is done, and the
next one failing does not undo it. Re-deriving a finished answer, or rewriting a
memory entry that was already written, is the expensive mistake here and the one
that actually gets made. Say which parts landed, which did not, and offer to
retry the rest.
