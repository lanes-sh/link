# Commands

Every command, its arguments, and its flags. `lanes link help` is the same list without the detail;
[`workflow.md`](workflow.md) walks the lifecycle in order.

**Every command names what it acts on.** `--profile <name>` and `--target <name>`, with no default
and no environment variable ([ADR-037](adr/037-a-command-names-what-it-acts-on.md)). They are
omitted from the tables below because they apply to almost everything; each entry says when a
command wants only `--profile`, or neither.

**`--json`, `--quiet` and `--help` are accepted everywhere.** Any other flag a command does not read
is refused, with a guess when the spelling is close.

**Values arrive on stdin.** `memory write`, `skills add`, `vault set` and `secrets set` read from a
pipe and refuse rather than hang when stdin is a terminal. `tasks add` is the exception: its notes
are optional, so an empty pipe or a terminal simply means a task with no notes.

> Three commands cannot be run at all, several documented flags are refused when you type them, and
> a few more are accepted and ignored. Each is marked **broken** in its own entry, and the tables
> carry only what works. [#44](https://github.com/lanes-sh/link/issues/44) has the detail.

---

## Everyday

### `lanes link setup plan [<provider>]`

What connecting something involves: with no argument, every provider and whether it is connected;
with one, the console steps, the values, and the command to run.

| | |
|---|---|
| `--id <name>` | plan for a specific connection id |

```console
$ lanes link setup plan --profile personal --target local
$ lanes link setup plan gmail --profile personal --target local
```

### `lanes link connect <provider>[.<id>]`

Add an account. Run once per account — a second run adds a second account. `<provider>.<id>`
re-authorises an existing one.

It ends by asking what to call the connection, offering the account it just resolved:

```console
What should this be called? [ada@example.com]:
```

Pressing Enter takes the account, which is the usual answer. Anything else is written to `label` and
changes nothing else — see `relabel` below for why that is a separate field from `account`. The
question is skipped when `--label` says it, when there is no terminal to ask, and for the second and
third service of a family: `connect icloud` is one account, so it is named once rather than
three times.

| | |
|---|---|
| `--id <name>` | the connection id, instead of one derived from the account |
| `--display-name <text>` | whose account this is, for a provider that cannot report it |
| `--label <text>` | what to call the connection, instead of being asked |
| `--replace` | ask for the stored password or key again |
| `--auth <method>` | which way in, where a provider offers two; `oauth` is the browser |
| `--own-client` | your own OAuth client rather than this project's (older spelling of an `--auth` route) |
| `--accept-broad-scopes` | agree in advance to scopes broader than the provider needs |
| `--non-interactive` | take every value from the credential store, or say what is missing |

```console
$ lanes link connect gmail --profile personal --target local
$ lanes link connect gmail --profile personal --target local --id work
```

`--target` never points at a running endpoint: `connect --target cloud` runs consent locally and
writes the token into the deployment's store.

### `lanes link disconnect <provider>.<id>`

Remove one account, and delete the credential it authorised. The counterpart to `connect`, and the
two edits it takes: the entry leaves `connections:` in the profile, and the credential leaves the
target's store.

The key must be exact. `connect gmail` can create an account and choose the id; there is nothing to
choose here, and a bare `gmail` with two accounts declared would be a command guessing which one to
throw away — so it refuses and names them.

```console
$ lanes link disconnect gmail.side --profile personal --target local
$ lanes link disconnect gmail.side --profile personal --target local --yes --json
$ lanes link disconnect gmail.side --profile personal --target local --keep-credential
```

**Three things it deliberately does not do.**

It does not delete the state record. Reconcile marks an undeclared connection `disabled` rather than
deleting it so the audit log keeps meaning something, and reaching past that to erase the record
would undo the one guarantee the log offers. The next reconcile marks it, and the command says so.

It does not delete a credential something else still resolves to. A reference is per connection for
an OAuth provider (`<provider>/<id>`), and *shared* for a manifest declaring `credential_ref` —
deleting that one while a sibling resolves to it would take the sibling's credential with it, and
the sibling would then report `unauthorized` for a `connect` nobody ran. When that happens the
credential is kept and the output names what still needs it.

It does not touch the owner layer. `memory`, `skills`, `vault`, `setup` and `identity` hold no
credential and are granted by a policy line this command does not touch, so removing the connection
alone would leave the policy granting against nothing — wrong, not merely untidy. It refuses and
points at the file, where both lines are next to each other.

### `lanes link relabel <provider>.<id> <name>`

Rename what an account is called. The label is what `status` and any surface built on it shows; it
is not an identifier, so nothing addresses the connection by it and changing one breaks nothing.

It writes `label`, never `account`, and the difference is not cosmetic. `account` is the identity
the provider reported, and three things read it as one: `settleIdentity` matches on it to decide a
second `connect` is a repair rather than a new account, the connection id is derived from it, and
`gmail.send_message` writes it into a `From` header. Renaming through `account` — which this command
did until the field existed — left a row the next `connect gmail` no longer recognised, and added a
second one beside it.

```console
$ lanes link relabel gmail.main "Work mail" --profile personal --target local
$ lanes link relabel gmail.main Work mail --profile personal --target local
```

Both forms work: an unquoted multi-word name is joined, because quoting is what someone remembers
second and refusing it teaches nothing.

`connect` already asks for one and offers the account as the answer, so this is for changing your
mind later — and for the surfaces that drive the CLI rather than type it. Allowed for the owner
layer, unlike `disconnect`: a display name is harmless, and "Memory" is the operator's word for
their own store.

The state store keeps the old name until the next reconcile, which updates it.

### `lanes link connect custom <id>`

Declare a service that is not built in, and connect it. The provider is composed from two fixed
lists — one connectivity type and one credential type — written to
`data/<profile>/providers.d/<id>.yaml`, and then connected exactly as a built-in is. The manifest is
yours to edit afterwards; `lanes link connect <id>` re-reads it every time.

Omit a required value and it is asked for. `--non-interactive` names every missing one at once
instead, with the command to re-run.

| | |
|---|---|
| `--connector <kind>` | `mcp`, `http`, `imap`, `dav`, `fs` |
| `--auth <method>` | `none`, `bearer`, `api-key`, `header`, `basic`, `oauth`, `strategy` |
| `--name <text>`, `--description <text>` | how the provider is labelled; the name defaults to the id read as words |
| `--endpoint <url>` | `mcp`: the URL the server speaks Streamable HTTP on |
| `--base-url <url>` | `http` and `dav` |
| `--openapi <url\|path>` | `http`: a URL, or a path resolved against the manifest's own directory |
| `--operations <globs>` | `http`: which operations to expose, by operationId, path or tag |
| `--service <kind>` | `dav`: `caldav` or `carddav` |
| `--host`, `--port` | `imap` |
| `--smtp-host`, `--smtp-port` | `imap`: omit the host and the mailbox is read-only, with no send capability |
| `--root <path>`, `--exclude <names>` | `fs` |
| `--header 'Name: value'` | sent on every request, repeatable; `mcp` and `http` only. Never `Authorization` |
| `--auth-header <name>` | the header the credential is sent in |
| `--auth-query <param>` | `api-key` only: the query parameter instead of a header |
| `--scopes <list>` | `oauth` |
| `--authorize-url`, `--token-url` | `oauth`: together or not at all; required on `http` |
| `--client-app <name>` | which `oauth_apps` entry holds the client; defaults to the id |
| `--registration <kind>` | `dynamic` or `manual`; `mcp` defaults to `dynamic`, everything else to `manual` |
| `--authorize-param k=v` | `oauth`: extra parameters on the authorization request, repeatable. Some vendors issue no refresh token without one |
| `--redirect-uri <url>` | only for a vendor that matches the whole redirect URL (ADR-045) |
| `--strategy <name>` | `strategy`: the name a provider in this build supplies, e.g. `bunq`. `http` only |
| `--strategy-option k=v` | `strategy`: repeatable, read by the strategy itself — a sandbox host, say |
| `--identity-url`, `--identity-field` | `http`: one GET that names the account, and which field to read |
| `--setup-docs <url\|text>` | where the credential comes from. A URL becomes a link, a sentence a step |
| `--replace-manifest` | rewrite a declaration that exists and differs. `--replace` is about the credential |

It also takes `--id`, `--display-name`, `--label`, `--replace`, `--accept-broad-scopes` and
`--non-interactive`, which are forwarded to the connect that follows.

```console
$ lanes link connect custom docs_server --connector mcp --auth oauth \
    --endpoint https://mcp.example.com/mcp --profile personal --target local

$ lanes link connect custom thing --connector http --auth api-key --auth-header X-Api-Key \
    --base-url https://api.example.com/v1 --openapi https://api.example.com/openapi.json \
    --profile personal --target local

$ lanes link connect custom mailbox --connector imap --auth basic \
    --host imap.example.com --smtp-host smtp.example.com --smtp-port 465 \
    --profile personal --target local
```

`--auth strategy` names code a provider in this build carries, which a manifest of your own can
borrow — the only way to point a connection at a vendor's sandbox, since a built-in manifest's
`options` are not yours to edit ([ADR-046](adr/046-an-auth-strategy-belongs-to-its-provider.md)).

Thirteen of the thirty-five possible pairs are legal, and the rest are refused with the alternative named —
an `mcp` connector has nowhere to put an API key, an `imap` one authenticates with a password, an
`fs` one holds no account at all.
[`connectivity-coverage.md`](connectivity-coverage.md) is the whole matrix, including what no pair
covers yet.

No flag carries a credential. The manifest declares what to ask for and the ordinary connect path
asks — the same reason `secrets set` reads stdin rather than an argument.

Two limits worth knowing. A declaration is written to the local filesystem, so this refuses a
workspace that is a bucket: declare it where you deploy from, and `lanes link deploy` carries it up.
And a failed connect leaves the manifest in place — that is the normal state of a hand-written one,
`status` reports it, and the retry is plain `lanes link connect <id>`.

### `lanes link start`

Reconcile, then serve every profile in the workspace on one endpoint.

| | |
|---|---|
| `--port <n>` | override the configured port |
| `--only` | serve the resolved profile alone |

```console
$ lanes link start --profile personal --target local
```

### `lanes link outputs`

The endpoint URL, whether it is answering, the profiles behind it, the token, and a registration
command to adapt.

| | |
|---|---|
| `--show` | reveal the token |

```console
$ lanes link outputs --profile personal --target local --show
```

### `lanes link dashboard`

Open the page a local endpoint serves. Local only — a deployed instance has no door a browser can
come through ([ADR-018](adr/018-the-gate-is-in-the-application.md)).

| | |
|---|---|
| `--print` | print the URL instead of opening a browser |

```console
$ lanes link dashboard --profile personal --target local
```

### `lanes link mcp add [claude|codex]`

Register this endpoint with an agent, and install the documents that describe it. With no argument,
every harness found.

| | |
|---|---|
| `--name <name>` | register under a name other than `lanes-link` |
| `--scope <scope>` | the harness's own scope; `user` by default |
| `--token-env <VAR>` | the variable a harness reads its token from; `LANES_LINK_TOKEN` by default |
| `--no-skill` | register only, leaving the agent's files alone |
| `--force` | replace a registration this name already has |
| `--dry-run` | print each command it would run, token redacted |

```console
$ lanes link mcp add --profile personal --target local
$ lanes link mcp add codex --profile personal --target local --no-skill
```

### `lanes link mcp list`

Where this endpoint is registered, and whether each harness's copy of the documents is current.
Needs no profile and no target.

| | |
|---|---|
| `--name <name>` | look under a different registration |
| `--scope <scope>` | look in a different scope |

```console
$ lanes link mcp list
```

### `lanes link mcp stdio`

Serve on stdin and stdout, for a client that spawns the command rather than calling a URL. Not typed
by hand — it is what a config file names.

| | |
|---|---|
| `--only` | serve the resolved profile alone |

```console
$ lanes link mcp stdio --profile personal --target local
```

### `lanes link mcp skill`

The bundled agent skill: its path, or the document itself.

| | |
|---|---|
| `--print` | write the document to stdout |
| ~~`--force`~~ | **broken** — accepted and ignored |

```console
$ lanes link mcp skill --print
```

### `lanes link status`

Names a `--target`. With no `--profile` it reports the whole workspace at that target: every
profile, whether it declares it, and how many connections each has — which is how a target declared
by one profile and not its sibling becomes visible. With `--profile` it is the detailed view:
connections, the capabilities reachable through them, and where the endpoint is.

No network call and no store opened either way, so it still answers for a target whose stores are
unreachable — which is the case you most want an answer in.

```console
$ lanes link status --target cloud                      # every profile
$ lanes link status --profile personal --target local   # one, in detail
```

---

## Profiles

### `lanes link profile add <name>`

Write a new profile, and the workspace file if it is the first. Names no profile and no target of its
own.

| | |
|---|---|
| `--target <name>` | a target per place it runs, repeatable; `local` is derived, others copied from a sibling |
| `--non-interactive` | never prompt |

```console
$ lanes link profile add personal --target local
```

### `lanes link profile list`

Every profile in the workspace and its path. Needs no profile and no target.

```console
$ lanes link profile list
```

### `lanes link profile remove <name>`

The profile, its credentials, its data, and its config file. Best effort: one refusal does not stop
the rest, and anything that survived exits non-zero. The confirmation asks you to type the name.

| | |
|---|---|
| `--dry-run` | print the plan, write to nothing |
| `--yes` | skip the confirmation |
| `--target <name>` | decommission one target's stores, leaving the profile file in place |

```console
$ lanes link profile remove work --dry-run
```

The positional name is what gets removed. `--profile` is refused, as it is on `profile add`: both
name their profile positionally, so a flag naming a second one could only disagree with it.

### `lanes link profile default <name>`

**Removed.** It wrote `default_profile`, which nothing reads. Kept as a refusal for one release.

```console
$ lanes link profile default work
error  lanes link profile default was removed.
```

---

## Targets

A target names where a profile runs: a credential store, a blob store, optionally a deployment.
Everything above them is declared once and applies to all of them.

### `lanes link target list`

What this profile declares, and which one you named. Reads the file and asks nobody. Requires no
target — it is the command you run to find out what to pass.

| | |
|---|---|
| `--urls` | add each deployable target's address, one platform lookup apiece |
| `--target <name>` | mark one, and warn if it is not declared |

```console
$ lanes link target list --profile personal
```

### `lanes link target show <name>`

One target's adapters, its deployment, the address it answers on, and which release rolled it. Asks
the platform for the address; the release comes off the registry, so it answers with the service
scaled to zero.

| | |
|---|---|
| `--target <name>` | the target, if not given positionally |

```console
$ lanes link target show local --profile personal
```

### `lanes link target use <name>`

**Removed.** It wrote `instance.default_target`, which nothing reads. Pass `--target` instead.

```console
$ lanes link target use cloud
error  lanes link target use was removed.
```

---

## Who you are

### `lanes link identity add <kind> <value>`

Declare one entry. `kind` is yours to choose — `name`, `email`, `github` are conventions. Order is
the ranking. The first `add` also writes the connection row and the `identity.*` grant.

| | |
|---|---|
| `--note <text>` | when this entry applies, read by whatever picks between several of a kind |

```console
$ lanes link identity add name "A. Lovelace" --note "for anything published" \
    --profile personal --target local
```

### `lanes link identity list`

The block, and whether anything but the file can read it. Takes `--profile` only.

```console
$ lanes link identity list --profile personal
```

### `lanes link identity remove <kind> <value>`

Drop one entry, leaving the connection row and the grant in place.

```console
$ lanes link identity remove name Ada --profile personal --target local
```

---

## Permissions

Default deny. A deny beats any allow whatever the order in the file, and the only operator beyond an
exact name is a trailing `.*`.

### `lanes link policy list`

The rules in force. Takes `--profile` only.

```console
$ lanes link policy list --profile personal
```

### `lanes link policy allow <capability>`

Grant a capability, or a provider with `gmail.*`. A rule naming an unknown connection is refused at
write time. Widening a *vendor* scope needs browser re-consent and goes through `connect`.

```console
$ lanes link policy allow gmail.send_message --profile personal --target local
```

### `lanes link policy deny <capability>`

Refuse a capability, whatever else allows it.

```console
$ lanes link policy deny skills.manage.* --profile personal --target local
```

### `lanes link token show`

The one bearer token this endpoint accepts, truncated unless asked otherwise.

| | |
|---|---|
| `--show` | reveal it |
| `--raw` | print only the token, no resolution line, for `$(…)` |

```console
$ lanes link token show --raw --profile personal --target local
```

### `lanes link token rotate`

Mint a new token; invalidates the old immediately. Every agent must be registered again — a harness
stores the token it was given, not the command that produced it.

| | |
|---|---|
| `--show` | reveal the replacement |
| ~~`--raw`~~ ~~`--yes`~~ | **broken** — accepted and ignored |

```console
$ lanes link token rotate --profile personal --target local
```

---

## Your own context

Memory, tasks, assets, skills and the vault are providers holding your material rather than an
account, so a profile arrives with all five declared and granted — there is nothing to connect
([ADR-050](adr/050-the-owner-layer-is-granted-by-default.md)). Each also has a CLI of its own, which
reaches the same bytes an agent does.

Which store a thing goes in: **memory is what is true, tasks is what is to be done, assets is a
file.** Nothing refuses the wrong choice, so it is worth knowing —
[ADR-051](adr/051-tasks-and-assets-are-their-own-stores.md) has the reasoning.

`--connection <id>` picks between several of a kind; with exactly one it is inferred.

### `lanes link memory list`

Ids, titles, tags, and the date each was last written.

| | |
|---|---|
| `--connection <id>` | which memory connection |
| `--tag <tag>` | only memories carrying this tag |
| ~~`--raw`~~ | **broken** — refused |

```console
$ lanes link memory list --profile personal --target local
```

### `lanes link memory get <id>`

One entry's body, as stored.

```console
$ lanes link memory get deploy-window --profile personal --target local
```

### `lanes link memory write <id>`

Create or replace one entry; body on stdin. An entry is one Markdown file with YAML frontmatter, so
a text editor is an equally good client.

| | |
|---|---|
| `--title <text>` | what a listing shows; a rewrite without one keeps the existing title |
| `--connection <id>` | which memory connection |
| ~~`--tag <tag>`~~ | **broken** — refused, though the help text lists it |

```console
$ printf 'The deploy window is Thursday evening.' \
    | lanes link memory write deploy-window --title "Deploy window" \
        --profile personal --target local
```

### `lanes link memory forget <id>`

Delete one entry, after printing it and asking.

> **Broken in a script** — with no terminal it says "Pass `--yes` to proceed", and `--yes` is
> refused. Interactive use is unaffected.

```console
$ lanes link memory forget deploy-window --profile personal --target local
```

### `lanes link tasks list`

What is outstanding: id, status, title, due date, tags. Shows `in_progress`, `open` and `blocked`
and hides the rest, because the question is almost always what is left to do.

| | |
|---|---|
| `--connection <id>` | which tasks connection |
| `--status <status>` | one status, or `all` for everything |
| `--tag <tag>` | only tasks carrying this tag |

```console
$ lanes link tasks list --profile personal --target local

Tasks (2 outstanding)
  write-the-release-notes  in_progress  write the release notes
  chase-the-invoice        open         chase the invoice        due 2026-09-01  billing
```

### `lanes link tasks get <id>`

One task: title, status, due date, tags, then the notes.

```console
$ lanes link tasks get chase-the-invoice --profile personal --target local
```

### `lanes link tasks add <title>`

Record something to be done. The title is the argument, because a task is usually one line; notes
are optional and read from stdin when there are any. A task is one Markdown file with YAML
frontmatter, so a text editor is an equally good client.

| | |
|---|---|
| `--status <status>` | `in_progress`, `open`, `blocked`, `muted`, `done`, `dropped`. Defaults to `open`. |
| `--due <when>` | as you would write it — `2026-09-01`, or a full instant. Kept verbatim. |
| `--tag <tag>` | one label |

```console
$ lanes link tasks add "chase the invoice" --due 2026-09-01 --profile personal --target local
ok    added task chase-the-invoice

$ printf 'Third reminder.' | lanes link tasks add "chase the invoice" --profile personal --target local
```

The id is derived from the title. Adding under an id that exists replaces it, keeping the date it
was first recorded.

### `lanes link tasks update <id>`

Change a task in place. **This is how a task is closed** — the record of having done it is the useful
half, and it is what stops the same thing being suggested next week. Omitted flags leave their fields
alone.

| | |
|---|---|
| `--status <status>` | the new status |
| `--title <t>` | replaces the title |
| `--due <when>` | replaces the due date; `--due ""` clears it |
| `--tag <tag>` | replaces the tags |

```console
$ lanes link tasks update chase-the-invoice --status done --profile personal --target local
ok    updated task chase-the-invoice — now done
```

### `lanes link tasks remove <id>`

Delete a task, after printing it and asking. For something finished or decided against, prefer
`update --status done` or `--status dropped`: deleting loses the record that it happened.

| | |
|---|---|
| `--yes` | skip the confirmation |

```console
$ lanes link tasks remove mistake --yes --profile personal --target local
```

### `lanes link assets list`

Every file kept in this profile, newest first, with its type and size. This is the whole index — an
asset carries no description, so what a file is *for* belongs in memory beside its name.

```console
$ lanes link assets list --profile personal --target local

Assets (2)
  blob.bin    application/octet-stream  3 KB  2026-08-27
  report.csv  text/csv                  12 B  2026-08-27
```

### `lanes link assets get <name>`

The bytes, to stdout. **Redirect them** — it refuses a terminal rather than writing a binary into
your scrollback.

```console
$ lanes link assets get invoice.pdf --profile personal --target local > invoice.pdf
```

This is the one place the CLI and the capability deliberately differ: `assets.get` over MCP describes
a binary rather than returning it, because a conversation has a context window and a shell does not.

### `lanes link assets add <file>`

Keep a file. A path on this machine — the other four sources the capability takes exist because the
endpoint may not be where the caller is, and a CLI already is.

| | |
|---|---|
| `--name <n>` | what to call it, where the path's basename is wrong |
| `--content-type <t>` | for the file whose extension does not say what it is |

```console
$ lanes link assets add ~/Downloads/invoice.pdf --profile personal --target local
ok    kept invoice.pdf — 184 KB, sha256 9284ed4fd7fe…
```

Storing under a name that exists replaces it. A name may not contain a path separator, start with a
dot, or end `.meta` or `.tmp` — the last two are suffixes a blob store keeps its own bookkeeping
under and would hide the file.

### `lanes link assets remove <name>`

Delete a file, after printing it and asking. There is no trash.

| | |
|---|---|
| `--yes` | skip the confirmation |

```console
$ lanes link assets remove invoice.pdf --yes --profile personal --target local
```

### `lanes link skills list`

The procedures agents can invoke, and each description.

| | |
|---|---|
| `--connection <id>` | which skills connection |
| ~~`--raw`~~ | **broken** — refused |

```console
$ lanes link skills list --profile personal --target local
```

### `lanes link skills show <name>`

One skill exactly as stored, frontmatter included.

```console
$ lanes link skills show review-diff --profile personal --target local
```

### `lanes link skills add <name>`

Create or replace one skill. A whole Markdown document: YAML frontmatter carrying a `description`,
then the body, where `{{argument}}` is substituted at invocation. **The `---` fence is required.**

| | |
|---|---|
| `--file <path>` | read the document from a file rather than stdin |
| `--connection <id>` | which skills connection |

```console
$ lanes link skills add review-diff --file review-diff.md --profile personal --target local
```

Becomes the MCP prompt `skills_<name>`; a running endpoint picks it up within seconds.

### `lanes link skills remove <name>`

Delete one skill, after asking.

> **Broken in a script** — same as `memory forget`: it asks for `--yes`, and refuses `--yes`.

```console
$ lanes link skills remove review-diff --profile personal --target local
```

### `lanes link knowledge show`

Where this profile's memory and skills are kept, and how many of each.

```console
$ lanes link knowledge show --profile personal --target local
```

### `lanes link knowledge use github|local`

Keep memory and skills in a private GitHub repository, over the API — or bring them back onto the
target's own storage. The block is written into every target the profile declares; each still needs
the token in its own store, which is what `secrets push` is for
([ADR-041](adr/041-memory-and-skills-in-a-repository.md)).

| | |
|---|---|
| `--repo <owner/name>` | the repository |
| `--branch <name>` | the branch |
| `--path <prefix>` | a subdirectory rather than the root |
| `--migrate` | move what is already stored, in one commit |
| `--no-migrate` | switch and leave it where it is |
| `--keep` | move it, and leave the local copies in place, unread |
| `--allow-public` | proceed against a public repository, otherwise refused |
| `--replace` | ask for the token again |
| `--yes` | skip the confirmations |

```console
$ lanes link knowledge use github --repo my-org/my-notes --migrate \
    --profile personal --target local
$ lanes link knowledge use local --migrate --profile personal --target local
```

### `lanes link vault list`

Names and descriptions, never values.

| | |
|---|---|
| `--connection <id>` | which vault connection |

```console
$ lanes link vault list --profile personal --target local
```

### `lanes link vault get <id>`

One item, truncated to a few characters and a length.

> **Broken** — `--show` and `--raw` are both refused, so there is no way to reveal a value. The
> output tells you to pass `--show`.

```console
$ lanes link vault get github_token --profile personal --target local
pla…  (11 chars — --show to reveal)
```

### `lanes link vault set <id>`

Store one item; value on stdin. Not readable over MCP until the endpoint restarts, and it needs a
`vault.get.<id>` grant.

| | |
|---|---|
| ~~`--description <text>`~~ | **broken** — refused, though the help text lists it |

```console
$ printf %s "$SOME_TOKEN" | lanes link vault set github_token --profile personal --target local
```

### `lanes link vault remove <id>`

Delete one item, after asking. The value cannot be recovered.

> **Broken in a script** — asks for `--yes`, and refuses `--yes`.

```console
$ lanes link vault remove github_token --profile personal --target local
```

### `lanes link vault key generate`

Mint a `LANES_LINK_VAULT_KEY` and print it once. Written nowhere — a key beside the ciphertext it
protects protects nothing. Needs no profile and no target, and refuses both.

```console
$ lanes link vault key generate
```

---

## Deploying

### `lanes link deploy`

Set up what is missing, build the image, roll one revision, print the URL. Names a `--target` and
sends **every profile that declares it**, because that is the set the endpoint will open. See
[`deployment-cloudrun.md`](deployment-cloudrun.md).

| | |
|---|---|
| `--profile <name>` | only these, repeatable; the first owns the endpoint's token |
| `--dry-run` | print every platform command, run none |
| `--access iam\|public` | who gets past the platform's own door |
| `--iam` | older spelling of `--access iam` |
| `--service-account <name>` | the identity the revision runs as |
| `--tag <name>` | the image tag; a UTC timestamp by default |
| `--yes` | skip the confirmations |
| `--non-interactive` | take the stored answers, never prompt |

```console
$ lanes link deploy --target cloud --dry-run                     # every profile declaring it
$ lanes link deploy --target cloud --profile personal --dry-run  # only this one
```

A first deploy is the exception: a target no profile declares yet has no set to derive, so name the
profile it belongs to and `deploy` creates the target in it.

It refuses two things rather than deciding them. Which profile owns the endpoint's token, when more
than one declares the target and no previous deploy recorded an answer — one token reaches every
profile behind it. And a deploy where two profiles would write the same flat credential reference
into the one store the target has, which would leave one of them reading the other's account.

### `lanes link sync targets`

Reconcile the workspace with the copy a deployment reads. Names a `--target`; `--profile` narrows it
to one.

Anything one side is missing is copied to it; anything both sides hold differently stops the run and
prints the difference. Credentials, state and the audit log are never copied — only config, skills
and provider manifests, which is exactly what a deploy uploads.

| | |
|---|---|
| `--from gs://<bucket>` | where the deployment's copy lives, when nothing here says |
| `--discover` | ask the platform to find it — the only route that works from nothing |
| `--prefer local\|remote` | which side wins where both disagree |
| `--dry-run` | print the differences, write to neither side |

```console
$ lanes link sync targets --target cloud --dry-run
$ lanes link sync targets --target cloud
personal
  ← targets.cloud             missing locally
  ← connections.gmail.work    missing locally
```

This is how a target lost from a profile comes back: the deployment is still running and its bucket
still holds the profile as the last deploy left it. Where to look is tried cheapest first — a target
you still declare, then the `deployments:` index `deploy` writes into `lanes-link.yaml`, then
`--from`, then `--discover`.

`connect` comes after the first deploy — a store that does not exist yet is not somewhere to write a
credential — and a second deploy is what gets a revision to see those accounts.

### `lanes link secrets list`

Credential reference names in this target. No command here prints a value.

```console
$ lanes link secrets list --profile personal --target local
```

### `lanes link secrets set <ref>`

Store one credential value, read from stdin.

```console
$ printf %s "ada@example.com:xxxx-xxxx-xxxx-xxxx" \
    | lanes link secrets set icloud/ada --profile personal --target local
```

### `lanes link secrets push`

Copy credential values between two targets' stores. Takes `--profile` only — `--from` and `--to`
name the targets, so `--target` is refused.

| | |
|---|---|
| `--from <target>` | source |
| `--to <target>` | destination |
| `--overwrite` | replace a reference the destination already holds |
| `--dry-run` | print what would be copied |

```console
$ lanes link secrets push --from local --to cloud --profile personal
```

Copies and never deletes, and skips what the destination has unless `--overwrite` — the deployed copy
may be newer.

---

## Inspection

Cheapest first: `check` (static), `doctor` (read-only external), `plan` (what would change), then
`start` or `deploy`.

### `lanes link check`

Static validation: contract major, no credential values in config, referential integrity, targets
resolvable. No external call. Takes `--profile` only.

```console
$ lanes link check --profile personal
```

### `lanes link doctor`

Credentials resolve, stores reachable, token present, state agrees with config. Also reports
capabilities the upstream has grown since you connected. Exits non-zero on a finding, each carrying
the command that fixes it.

```console
$ lanes link doctor --profile personal --target local
```

`--fix` applies the one repair `doctor` can make on its own: a provider this project renamed under
you, where the profile still names the old id. That refusal happens at config load, so it takes
every other command down with it — `doctor` is the one that still answers, and it moves the
connection row, its policy rules and the stored credential together. Everything else `doctor`
reports is a decision only you can make, and `--fix` does not touch it.

```console
$ lanes link doctor --fix --profile personal --target local
```

Without `--fix` it prints what it would move and writes nothing.

### `lanes link plan`

What reconcile would change, and nothing else. Reconcile disables undeclared connections, which
should never be a surprise.

```console
$ lanes link plan --profile personal --target local
```

### `lanes link tools`

What the endpoint would hand a client right now, asked over the wire — one `initialize`, one
`tools/list`. Not derived from config, which is the point. Reports refused and unreachable as
different problems.

```console
$ lanes link tools --profile personal --target local
```

### `lanes link audit tail`

The log the dispatcher writes, allowed and denied both, arguments redacted per provider.

| | |
|---|---|
| `--limit <n>` | how many entries |
| `--denied-only` | the interesting half |
| `--format md` | a Markdown table |

```console
$ lanes link audit tail --limit 25 --denied-only --profile personal --target local
```

### `lanes link audit verify`

Whether anything in the log has been altered or removed. Each record carries the hash of the one
before it, so an edit shows as a mismatch, a removal as a sequence gap, and a truncated run as a
count that disagrees with its marker. Exits non-zero on a break.

| | |
|---|---|
| ~~`--limit <n>`~~ ~~`--format <f>`~~ | **broken** — accepted and ignored; it walks every chain regardless |

```console
$ lanes link audit verify --profile personal --target local
```

### `lanes link config show`

The resolved config as JSON. Takes `--profile` only.

```console
$ lanes link config show --profile personal
```

### `lanes link version`

Which release this is. Same as `lanes --version`. Needs no profile and no target.

```console
$ lanes link version
```

### `lanes link update`

Install the newer release. There is no build step, so an update replaces the installed package
directory. Bun only; from a checkout it refuses and says `git pull` is the update there. Needs no
profile and no target.

| | |
|---|---|
| `--check` | report only, exiting non-zero when a newer release exists |

```console
$ lanes link update --check
```

---

## Attachments

### `lanes link attach <file>`

Stage a file and print the handle a send can name it by. A `path` attachment names the filesystem the
*endpoint* sees, which stops meaning anything once the endpoint is not where the file is; a handle
does not care.

| | |
|---|---|
| `--connection <provider>.<account>` | which connection the attachment belongs to |

```console
$ lanes link attach ./report.pdf --connection gmail.main --profile personal --target local
```

---

## Aliases

### `lanes link skill`

The older spelling of `mcp skill`, from before `lanes link skills` existed. Kept working,
unadvertised.

| | |
|---|---|
| `--print` | write the document to stdout |
| ~~`--force`~~ | **broken** — accepted and ignored |

```console
$ lanes link skill --print
```

### `lanes link help`

The command list at a glance. Also `lanes link --help`, and `--help` on any command.

```console
$ lanes link help
```

---

## Selection

**Workspace root:** `LANES_LINK_HOME`, then the nearest ancestor holding `lanes-link.yaml`, then
`~/.lanes-link`.

**Profile and target:** `--profile` and `--target`, and nothing else — no variable, no config key, no
default ([ADR-037](adr/037-a-command-names-what-it-acts-on.md)). A command naming neither refuses and
lists what there is to choose from. `instance.default_target` and `default_profile` are still parsed
and no longer read, so `check` and `doctor` can tell you the line is inert.

**Refuse `--target`:** `check`, `config show`, `policy list`, `identity list`, `secrets push`.

**Require no target:** `target list`.

**Name neither:** `profile add`, `profile list`, `profile default`, `target use`, `mcp list`,
`mcp skill`, `skill`, `vault key generate`, `version`, `update`, `help`.
