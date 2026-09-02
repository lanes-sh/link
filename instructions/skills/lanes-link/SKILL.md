---
name: lanes-link
description: Use when the user refers to their own accounts, knowledge, procedures, or secrets through Lanes Link — "check my mail", "what do I know about X", "remember this", "which profile am I in" — or asks to connect, register, or set up their Lanes Link MCP server with this agent. Also covers operating the workspace from a shell — signing in, adding a connection, granting it to a profile, adding or removing a profile, deciding who may consume one, deploying an endpoint or recovering a lost deployment — and what to do when a Lanes Link call is refused, or when the endpoint is not running.
---

# Lanes Link

A self-hostable gateway to one person's own context: the accounts they have
connected, the knowledge they have accumulated, the procedures they have
written down, and their secrets. One endpoint serves every profile in a
workspace, and each call names which profile it means.

The endpoint describes its own live state when you connect — which profiles
exist, what is reachable in each — and serves the long form of this at
`lanes://instructions`. This file is the part that does not change: how to
behave with it.

## Three words, and they changed in 0.8.0

A **connection** is one authorised account, and it belongs to the **workspace**.
A **profile** is a selection: which connections it includes, what it allows on
each, and who may consume it.

That ordering is the change. A connection used to live inside one profile, so
reaching the same mailbox from two of them meant authorising it twice, and every
account of a provider within a profile was governed identically. Now the account
is authorised once and each profile decides what it may do with it, which is what
makes "read this mailbox, write that calendar" something a person can write down.

**"Target" is gone.** It named the thing a workspace already was. `--workspace`
is the flag; `--target` still works for one minor and warns.

## Profiles are a boundary, not a setting

Every tool takes `profile` and `connection`. Profiles are how someone keeps work
and personal apart; a connection they do not grant is not visible in one at all.

**Ask which profile is meant when it is ambiguous. Do not default to whichever
is listed first.** Quietly picking one crosses the line the profile exists to
draw. There is no "current profile" to switch — the choice is made per call, and
`lanes link profile list --workspace <name>` shows what exists *in that
workspace*. A profile lives in exactly one, so `personal` on `local` and
`personal` on `cloud` are two profiles that share a name rather than one profile
in two places.

**What a command must be told is never inferred from a profile — but the
workspace may have a default.** `lanes set-workspace <name>` writes one, every
command that uses it echoes the name it resolved, and the commands where being
wrong is expensive refuse it and demand the flag: `deploy`, `sync`,
`secrets push`, `profile remove`, `disconnect`, `token rotate`. Passing a flag a
command does not read is refused too, which makes "add both to be safe" its own
failure. Four levels:

- **Neither.** `lanes link workspace list`, `lanes link mcp list`,
  `lanes link version`, `lanes link mcp install-instructions`.
- **`--workspace` alone.** `lanes link profile list`, `lanes link profile add`,
  `lanes link profile remove`, `lanes link workspace show`,
  `lanes link connection list`. A connection and a profile both live inside one
  workspace, so listing or creating either names which.
- **`--workspace`, with the profiles derived from it.** `lanes link status`,
  `lanes link deploy` and `lanes link sync workspaces` act on one endpoint
  serving every profile in that workspace. `--profile` is accepted and *narrows*
  the answer; it does not choose the subject.
- **Both.** Everything acting on one account, and everything reaching the
  owner's own stores: `lanes link connect`, `lanes link token rotate`,
  `lanes link secrets set`, `lanes link policy allow`, `lanes link grant add`,
  `lanes link profile members`, `lanes link memory list`,
  `lanes link tasks list`, `lanes link assets list`, `lanes link mcp add`.

`lanes link profile add` and `lanes link profile remove` **reject** `--profile`.
Both name their profile positionally, so a flag naming a second one could only
disagree with it.

When you write a command out for the owner, fill in what that command needs or
leave it as `<name>` for them to complete — never drop a required one.

A `connection` names an account the profile grants. One profile may grant
several of the same kind and govern each differently, so `gmail.work` may be
readable where `gmail.personal` is writable. Naming a connection the profile does
not grant is refused rather than guessed at, and a connection it does not grant
is absent from the enum entirely: if you cannot see it there, it was not
withheld by accident.

## Which store a thing goes in

Three of them hold what the owner keeps, and they divide by what a thing *is*.
Getting this wrong is the most common way to be unhelpful here, because nothing
refuses it — the write succeeds, in the wrong place, and stays there.

- **memory** — what is *true*. A fact, a preference, a decision, how something
  works. It has no state, because a fact does not finish.
- **tasks** — what is to be *done*. It carries a status, so it can be closed.
- **assets** — a *file*. Bytes, kept under a name.

**"Remember to…" is a task, not a memory entry.** So are "add a todo", "don't
let me forget", "put this on my list", and anything with a deadline in it. Filed
as memory it becomes a note that nothing can ever close, and it will be read
back to them as a fact forever. The give-away is a verb: *chase the invoice* is
a task, *invoices are paid on the 1st* is memory.

The reverse matters too. **A fact with no action in it is not a task.** Filing
one as a task puts something on a list that can never legitimately be marked
done.

And **a procedure is neither** — see the next section. If they say "always do X
when Y", that is a skill they should write, not a memory entry describing it.

## Reach for memory before answering from nothing

`lanes_memory.search` before concluding you do not know something about this person or
their work. It is a substring search over their own notes, not a ranked index —
try more than one wording before deciding it is not there.

Writing is a separate grant, and it should be. What you write is served back to
every later session, including to a different agent, so **write when you are
asked to remember something, not as a habit.** The owner reaches the same
entries with `lanes link memory list --profile <name> --workspace <name>` and a text editor.

## Tasks have a status, so finish them rather than deleting them

`lanes_tasks.list` answers what is outstanding. It shows `in_progress`, `open` and
`blocked` and hides the rest, so a listing is what is left to do rather than
everything that ever was — name a status to see more.

Six of them, and the two that are easy to confuse are worth learning:

| | |
|---|---|
| `in_progress` | started |
| `open` | not started |
| `blocked` | waiting on something that is not the owner |
| `muted` | deliberately not being surfaced — they asked not to be reminded |
| `done` | finished |
| `dropped` | decided against, which is not the same as finished |

**Closing a task is `lanes_tasks.update` with a status, never `lanes_tasks.remove`.** The
record of having done it is the useful half, and it is what stops the same thing
being suggested again next week. Remove is for something recorded by mistake.

Do not mute a task on your own initiative. It means "stop telling me about
this", which is the owner's judgement, not yours.

They manage these with `lanes link tasks list --profile <name> --workspace <name>`.

## Assets are files kept by name

Storing one names a source and the endpoint reads the bytes — the same five
sources the attachments section below describes, and the same rule: **never
encode a file into the call.** The name is the address; there is no id and no
description, so what a file is *for* belongs in memory, next to its name.

Reading gives you text when the file is text. Anything else comes back described
— name, type, size, digest — and that is not a refusal to work around. There is
no form of a read that hands you a PDF, and a megabyte of base64 in the
conversation would not help you if there were.

To attach a stored file to something you are sending, ask the owner to run
`lanes link attach <file> --profile <name> --workspace <name> --connection <provider>.<account>`,
which prints a handle the send tools take. An asset's own store is not reachable
from a mailbox's, deliberately.

They manage these with `lanes link assets list --profile <name> --workspace <name>`.

## Skills are theirs, not yours

A skill is a procedure the owner wrote down. They arrive as prompts — slash
commands — and are selected by the person rather than chosen by the model. You
cannot read a skill's body; that is deliberate, not a gap to work around.

So when a task has a skill for it, **say the skill exists and let them invoke
it** rather than improvising your own version of their procedure. They manage
these with `lanes link skills list --profile <name> --workspace <name>` and `lanes link skills show <skill> --profile <name> --workspace <name>`.

## Vault values are credentials

Use one to do the thing that needs it. Never quote it back, summarise it, echo
it into a file, or paste it into a command whose output you will show. If a
value has been printed by accident, say so.

## Who you are writing as is declared, not inferred

A profile may declare the names, addresses and handles its owner wants used when
something is written as them. Call `lanes_identity_list` for the profile in play
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
--workspace <name>` — both flags, because neither has a fallback.
Nothing you can call writes here, deliberately.

## Who you are writing *to* is declared as well

`lanes_entities_find` holds the people, companies and projects this owner deals with,
with the addresses and handles to reach each of them. Call it before using
anyone's address — do not recall one from earlier in the conversation, and do
not lift one off a message you happen to have read.

**It answers with every match and never chooses between them.** One match is an
answer. More than one is a question: the reply shows what separates the
candidates, so settle it from what you already know if that is genuinely
unambiguous, and otherwise **ask**. Do not take the first — the order is not a
ranking, and nothing about the reply is an error you need to work around.

None matching is not a failure either. It means the owner has not written that
person down, so ask rather than using an address from somewhere else.

Where an entity holds two of a kind — a work address and a personal one — the
first is the default and the notes say when to prefer the other, exactly as
identity works.

Writing is a separate grant. Where you have it, `lanes_entities_write` declares one
and `lanes_entities_link` relates two; a field you do not send is left as it is.
`lanes_entities_forget` does not clean up edges pointing at what it removed, and says
which ones will dangle.

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
`lanes link attach <file> --profile <name> --workspace <name> --connection <provider>.<account>`, which prints a
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
`lanes link policy list --profile <name> --workspace <name>` shows the rules, `lanes link policy allow <capability> --connection <provider>.<id> --profile <name> --workspace <name>`
changes them, and that is their call, not yours. **Do not look for another route
to the same data.** Every call is audited either way; `lanes link audit tail --profile <name> --workspace <name>`
shows what was attempted, refusals included.

## Setting something up

Call `lanes_setup_overview` before answering any question about what you can reach, and
before suggesting that anything be connected. It names the accounts reachable in a
profile and the providers that are not connected yet. `lanes_setup_provider` then gives
one provider's console steps, the values it will ask for, and the exact command.

**Memory, tasks, assets, skills and the vault need no setup at all.** They hold
the owner's own material rather than an account, so a profile arrives with all
five already reachable — there is no command to run and nothing to connect. If
one is missing, it was switched off with a `deny`, which is their decision; do not
offer to connect it. What setup is for is accounts: mail, calendar, files,
issues.

**Connecting authorises once; a grant is what a second profile needs.**
`lanes link connect <provider> --profile <name> --workspace <name>` authorises
the account into the workspace *and* grants it to the profile you named. Reaching
the same account from another profile is then a grant rather than a second
consent screen, which is the point of connections belonging to the workspace:

```
lanes link grant add gmail.<id> --profile work --workspace local
lanes link policy allow gmail.users.messages.list --connection gmail.<id> --profile work --workspace local
```

`lanes link connection list --workspace <name>` shows every connection with the
profiles that grant it, which is the answer when an owner says an account they
connected is not showing up somewhere.

**Take the command from `lanes_setup_provider`; never compose one yourself.** It carries
the right profile and, where the provider stores a credential per account, the
`--id` it needs. A command you assembled is one the owner pastes and watches fail.

You cannot do the setup. This endpoint writes no configuration and stores no
credential — those are `lanes link` in a terminal, deliberately. What you can do is
know exactly what to hand over, and say what it will ask for before they start.

If you have a shell, you can run it yourself for anything that does *not* need a
browser: `lanes link setup plan <provider> --profile <name> --workspace <name> --json` lists what to store,
`lanes link secrets set <ref> --profile <name> --workspace <name>` takes the value on stdin, and
`lanes link connect <provider> --profile <name> --workspace <name> --id <id> --non-interactive --json` finishes.
Anything with a browser sign-in belongs to whoever owns the account — give them
the line.

**Never pass `--accept-broad-scopes` yourself.** When a provider asks for more than
it needs, print the scopes and let the owner add the flag. Deciding that is theirs.

**A new connection is served at once; the tools you were handed are not.**
Connecting publishes the config to wherever that workspace's endpoint reads it and
asks the endpoint to re-read it, so a `lanes_setup_overview` straight after connecting
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
`lanes link doctor`, `lanes link profile list`, `lanes link workspace list`,
`lanes link workspace show`, `lanes link tools`, `lanes link config show` and
`lanes link audit tail`. None writes config, opens a browser, or costs anything,
and running one beats asking the owner to paste its output back. Give each what
its own level requires — they are not all the same, and the four levels are at
the top of this file.

**A command that writes runs `--dry-run` first, where it has one.** Show what it
reported and wait for an answer. `lanes link deploy`, `lanes link sync workspaces`,
`lanes link profile remove`, `lanes link secrets push` and `lanes link mcp add`
all take it. For a write with no dry run — `lanes link token rotate`,
`lanes link policy allow`, `lanes link secrets set` — say in one sentence what it
will change, then let them decide. Never a browser sign-in: that belongs to
whoever owns the account, as above.

**`--json` is not everywhere.** It parses on every command and is read by only
some, so one that ignores it prints its ordinary output and gives you nothing to
key on — do not treat the absence of JSON as a failure. `status`, `doctor`,
`tools`, `outputs`, `sync workspaces`, `workspace list`, `workspace show`, `profile list`,
`connect` and `setup plan` implement it. `deploy`, `check`, `plan`,
`config show`, `audit tail` and every `mcp` subcommand do not.

**A profile is created and removed, never switched.** `lanes link profile add
<name> --workspace <name>` writes a new one *into that workspace* — one
workspace, not a list, because a profile lives in exactly one.
`lanes link profile remove <name> --workspace <name>` takes `--dry-run` and then
`--yes`, and removes the profile itself along with its stores: the file is in
that workspace, so there is nowhere left for it to survive. Neither reads
`--profile`; both name the profile positionally.

There is no current profile. There *is* a default workspace, written by
`lanes set-workspace`, echoed by every command that uses it and refused by every
command that publishes or destroys. The two commands that used to pin a
profile or a workspace are gone and refuse with an explanation — if you
meet one of those refusals, it is not a broken install, and there is no
replacement to find. The choice is made per command, on purpose.

## Signing in, and who may consume a profile

Every human caller signs in with Lanes, on a local endpoint as much as a deployed
one. `lanes auth login` opens a browser once; `lanes auth status` says who this
machine is and when the session lapses. The network is needed to sign in and to
refresh, not per call, so a machine offline for a day keeps serving.

`lanes link start` refuses without a session, and names the command.

A profile declares who may consume it, and **empty means nobody**:

```
lanes link profile members add --me --profile assistant --workspace local
lanes link profile members list --profile assistant --workspace local
```

That list is a selection from the Lanes workspace rather than a second list
beside it, so `members list` shows both who may consume this profile and who is
in the workspace and could be given it. Somebody with an unaccepted invitation
has no subject yet, so they are listed, marked, and refused; the answer there is
for them to accept, not for anyone to invent a subject.

Removing somebody does not end a session they already hold: membership is read
when a token is minted. Rotating the endpoint token closes that
window now, and it names both flags: `lanes link token rotate --profile <name>
--workspace <name>`.

**A client is not given a token any more.** `lanes link mcp add` registers the
bare URL, and the client discovers the endpoint, sends its owner to sign in, and
comes back with a token of its own. The static token is for CI, which has no
browser, and `--headless` is what writes it into a registration. If you are
writing a registration command for somebody, do not add an `Authorization`
header: it is no longer how a client connects.

## Deploying, and what it decides

`lanes link deploy` builds an image and rolls a revision. Its subject is a
**workspace**, and the profiles behind it are every profile *in* that
workspace, so one deploy serves all of them — there is no per-profile deploy to
run and no reason to loop over them.

**Always `--dry-run` first, and show what it printed.** It creates cloud
resources that cost money, it implements no `--json` to inspect instead, and that
plan is the only place the consequences are visible while they are still
avoidable.

Two things it refuses to guess, and both are the owner's to answer:

- **Whose bearer token opens the endpoint.** One token reaches every profile
  behind that workspace, so this decides who gets in. With several candidates and
  nothing recorded, it refuses and prints the command that names one.
- **A first deploy.** A workspace that does not exist yet has nothing to derive
  a set from, so `--profile` is required there. It may be repeated, and the first
  one named is the primary.

**Never pass `--yes`, `--non-interactive`, `--access public` or
`--service-account` yourself.** Each settles a question about who can reach their
accounts. Print what the flag would decide and let them add it — the same rule
this file already applies to `--accept-broad-scopes`.

Deploying is how new code reaches the endpoint. It is not how an account gets
connected and not how a config change lands; both of those publish themselves.

## When a machine has lost track of a deployment

A workspace holds a *pointer* to each workspace it does not itself hold, and a
machine can lose one — a new laptop, a reinstall, a workspace file restored from
something older. The endpoint is still serving; what went missing is the line
saying where it lives. The symptom is a `lanes link status` that reports nothing
for a workspace you know is up.

`lanes link sync workspaces` adopts it. `--discover` looks for a deployment the
workspace has no pointer to, `--from <location>` names one directly, and
`--dry-run` reports what it would write without writing it. Run the dry run and
show it.

**It cannot lose anything.** Adopting writes one line — the pointer — and the
workspace at the other end stays authoritative for everything else. There is no
`--prefer` any more and passing one is refused: it chose a winner when a profile
existed in two copies that could disagree, and there is one copy now.

## Registering it, and re-registering it

`lanes link mcp add --profile <name> --workspace <name>` runs each harness's own registration command and installs
this skill where that harness keeps them. With no argument it does every harness
installed; name one (`claude`, `codex`) to be specific. Run it again after
`lanes link token rotate --profile <name> --workspace <name>` — add `--force`, since Claude Code stores the token as
a value rather than a command.

**Never paste the token.** There is a right way and a wrong way, and the
difference matters:

```bash
# RIGHT — the token goes from the CLI to the harness. You never see it.
claude mcp add --transport http lanes-link http://127.0.0.1:7337/mcp \
  --header "Authorization: Bearer $(lanes link token show --raw --profile <name> --workspace <name>)"

# WRONG — the token is now in your context, and in the transcript, forever.
lanes link token show --show          # then copying the value into the command
```

The token reaches every account of every profile the endpoint serves. Use the
substitution form. If you have already printed one by accident, say so and offer
`lanes link token rotate --profile <name> --workspace <name>`.

Prefer `lanes link mcp add --profile <name> --workspace <name>` to writing the command yourself: it checks the
endpoint is reachable, refuses to silently shadow an existing registration, and
cannot mistype the token. For a harness it does not know, take the command from
`lanes link outputs --profile <name> --workspace <name>` rather than writing it blind — that command checks whether
`lanes` resolves on this machine and prints a longer working form if it does
not, where guessing gives you an empty substitution, a `Bearer ` header, and a
401 that reads as a bad token.

If you register Codex, tell the user to export the token — Codex stores only the
variable name, so nothing works until it is set:

```bash
export LANES_LINK_TOKEN="$(lanes link token show --raw --profile <name> --workspace <name>)"
```

One registration covers every profile. Do not add one per profile; they share a
URL and a token.

`lanes link mcp list` needs neither flag and reports whether the registration and
this document are current, out of date, or absent. That is the cheap first
question when behaviour does not match what this file describes — an out-of-date
copy means the rules you are reading are not the ones that shipped.

Claude Desktop cannot be handed a URL, so it spawns the endpoint over stdio
instead. That one is named in the client's own config file rather than registered
by a command, as `lanes link mcp stdio --profile <name> --workspace <name>`; both
flags are required, and nothing may be written to stdout.

## When it is not running

`lanes link start --profile <name> --workspace <name>` runs in the foreground and
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
