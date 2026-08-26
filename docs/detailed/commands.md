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
pipe and refuse rather than hang when stdin is a terminal.

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

| | |
|---|---|
| `--id <name>` | the connection id, instead of one derived from the account |
| `--display-name <text>` | the label |
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

Connections, the capabilities reachable through them, and where the endpoint is. No network call; a
deployed target prints its identity rather than an address.

```console
$ lanes link status --profile personal --target local
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
| ~~`--target <name>`~~ | **broken** — refused, though the help text lists it, `removalPlan` branches on it, and the command prints it as remediation |

```console
$ lanes link profile remove work --profile personal --dry-run
```

The positional name is what gets removed; `--profile` is required as well and may differ.

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

One target's adapters, its deployment, and the address it answers on. Asks the platform.

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

> **Broken** — cannot be run. Without `--target` it refuses `--target is required`; with it,
> `Unknown flag "--target"`.

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

Memory, skills and the vault are providers — `connect memory`, `connect skills`, `connect vault` —
holding your material rather than an account, so they also have a CLI of their own. It reaches the
same bytes an agent does.

`--connection <id>` picks between several of a kind; with exactly one it is inferred.

### `lanes link memory list`

Ids, titles, tags, and the date each was last written.

| | |
|---|---|
| `--connection <id>` | which memory connection |
| ~~`--tag <tag>`~~ | **broken** — refused, though the help text lists it |
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

Set up what is missing, build the image, roll a revision, print the URL. See
[`deployment-cloudrun.md`](deployment-cloudrun.md).

| | |
|---|---|
| `--dry-run` | print every platform command, run none |
| `--access iam\|public` | who gets past the platform's own door |
| `--iam` | older spelling of `--access iam` |
| `--service-account <name>` | the identity the revision runs as |
| `--tag <name>` | the image tag; a UTC timestamp by default |
| `--yes` | skip the confirmations |
| `--non-interactive` | take the stored answers, never prompt |

```console
$ lanes link deploy --profile personal --target cloud --dry-run
```

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

> **Broken** — cannot be run. Without `--target` it refuses `--target is required`; with it,
> `Unknown flag "--target"`.

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

> **Broken** — cannot be run. Without `--target` it refuses `--target is required`; with it,
> `Unknown flag "--target"`.

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
