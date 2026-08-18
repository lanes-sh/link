# Workflow

The normative CLI contract. Implement against this; keep it updated when a command changes.

**Every command prints the resolved profile and target before acting**, read-only commands included.
It is the primary guard against operating on the wrong instance, and it costs one line.

```
profile personal (workspace-default)  target local (config-default)  /Users/you/.lanes-link
```

The parenthesised source matters: `profile: work` is much less useful than knowing it came from an
environment variable you forgot you exported.

## From nothing to a working endpoint

No external service and no credentials of any kind:

```console
$ lanes link profile add personal --default
ok    created profile personal
      config  ~/.lanes-link/profiles/personal.yaml
      port    7337
      set as the workspace default

Next: lanes link connect example    # add a connection, no credentials needed

$ lanes link connect example
ok    connected example.main
      providers.example.enabled = true
      connections += example.main
      granted read bundle:
        + example.echo
        + example.get_note
        + example.list_notes

Next: lanes link start

$ lanes link start
profile personal (workspace-default)  target local (config-default)  ~/.lanes-link
  + example.main  create (active)
ok    reconciled
warn  minted a profile token — run: lanes link outputs --show
ok    serving http://127.0.0.1:7337/mcp
Ctrl-C to stop.
```

In another shell:

```console
$ lanes link outputs --show
Endpoint
  http://127.0.0.1:7337/mcp  running

Profiles reachable through it (1)
  personal  (endpoint owner)
  Each call names one, in its `profile` argument.

Token
  llk_…

Register with your agent
  Not run for you: which config file an agent reads is its business, not ours.

  claude mcp add --transport http lanes-link http://127.0.0.1:7337/mcp \
    --header "Authorization: Bearer $(lanes link token show --raw)"
```

**The registration format is your agent's business, not ours.** Nothing in `lanes link` writes an
agent's config file — `lanes link mcp add` runs each harness's own `mcp add`, and the command above
is what it runs. Note the `$(…)`: the token is substituted by your shell, so it never passes
through an agent's context. It is resolved once and stored as a literal, so a `token rotate` means
registering again.

What `mcp add` *does* write is the agent skill, into the directory that harness reads it from —
there is no `claude skill add` to delegate to ([ADR-016](adr/016-what-the-endpoint-says-about-itself.md)).

## Adding accounts

One command, run once per account. The second run skips whatever the first established.

```console
$ lanes link connect example      # → example.main
$ lanes link connect example      # → example.main2
$ lanes link connect gmail        # → prompts for client id/secret once, then a browser
$ lanes link connect gmail        # → straight to the browser, another account
```

`lanes link connect gmail.main` re-authorises one existing account. `--id` overrides the derived connection
id; `--display-name` sets the label.

To see what one takes before starting — the console work, the values it will ask for, and whether
a browser is involved:

```console
$ lanes link setup plan               # every provider, connected or not
$ lanes link setup plan icloud_mail   # the steps, the values, the command
```

### Without a terminal to answer

`--non-interactive` never prompts. It resolves every value the manifest declares from the
credential store before writing anything, and refuses with what is missing and the command that
stores it:

```console
$ lanes link connect icloud_mail --id ada --non-interactive --json
{ "ok": false, "reason": "missing_credentials",
  "needs": [{ "ref": "icloud/ada",
              "command": "printf %s \"<username>:<password>\" | lanes link secrets set icloud/ada --profile personal" }],
  "then": "lanes link connect icloud_mail --profile personal --id ada --non-interactive" }

$ printf %s "ada@example.com:xxxx-xxxx-xxxx-xxxx" | lanes link secrets set icloud/ada
$ lanes link connect icloud_mail --id ada --non-interactive --json
```

Credentials go in through `secrets set` on stdin, never as a flag — an argument is in the shell
history, in `ps` output while the process runs, and in any transcript.

A provider that authorises in a browser is refused rather than attempted: the consent belongs to
whoever owns the account, and a listener nobody is watching times out after five minutes having
achieved nothing. Where scopes are broader than a provider needs, the run stops and prints
`--accept-broad-scopes` for a person to add deliberately.

## Two profiles side by side

One endpoint serves every profile in the workspace, and each call names the profile it means:

```console
$ lanes link profile add work
ok    created profile work

$ lanes-link --profile work connect notion
$ lanes-link --profile work policy deny notion.create-pages

$ lanes link start
ok    serving http://127.0.0.1:7337/mcp
      profiles: personal, work
```

Register it **once** — one URL, one token, both profiles ([ADR-009](adr/009-one-endpoint-per-workspace.md)):

```console
$ lanes link mcp add                 # every harness installed; or: lanes link mcp add codex
ok    registered lanes-link with Claude Code (user scope)
      installed skill at ~/.claude/skills/lanes-link/SKILL.md
      installed scout agent at ~/.claude/agents/lanes-link-scout.md
ok    registered lanes-link with Codex
      installed skill at ~/.codex/skills/lanes-link/SKILL.md

$ lanes link mcp list
Registered as lanes-link
  Claude Code    registered
                 skill: up to date
                 scout agent: up to date
  Codex          registered
                 skill: up to date
```

Two halves, with different rules. The registration shells out to each harness's own `mcp add`, so
nothing here writes an agent's config file. The documents are written directly, because no harness
has a command for installing one — run `mcp add` again after an upgrade and it refreshes them,
reporting `unchanged` when there was nothing to do. `--no-skill` skips that half.

For anything else, `lanes link outputs` prints the URL and a command to adapt, and the endpoint
tells it the short version of the same thing over MCP's `instructions` when it connects.

Every tool then takes a `profile` argument beside `connection`, and policy is evaluated against the
one named. `--only` serves the resolved profile alone.

Be clear-eyed about what this does and does not separate. Profiles share no database and no
credential store, so what one holds is invisible to another — but they now share an endpoint and its
token, so an agent holding that token can reach either by asking. **If you need a boundary that
holds against the agent itself, use a second workspace**, which shares nothing at all.

## Resolution order

**Workspace root:** `LANES_LINK_HOME` → nearest ancestor containing `lanes-link.yaml` → `~/.lanes-link`

**Profile:** `--profile` → `LANES_LINK_PROFILE` → `default_profile` → an error listing what exists.
Never a silent pick: the wrong guess operates on the wrong accounts.

**Target:** `--target` → `instance.default_target`

`deploy` alone resolves it differently: `--target` → the one target declaring a `deploy` block →
`cloud`. `instance.default_target` is where commands *run*, which is the local target — never an
answer to "deploy what", so falling back to it made the one unambiguous command the one that
insisted you say it. Several deployable targets is a real question and is asked rather than guessed.

There is deliberately **no sticky `lanes link use`**. Persisted context state is the standard way operators
run destructive commands against the wrong target; `export LANES_LINK_PROFILE=work` gives the same
convenience while staying visible in the shell.

## Permissions

```console
$ lanes link policy list
Allow
  +  example.echo        example.main
  +  example.get_note    example.main

Deny
  A deny beats any allow, whatever the order in the file.
  -  example.echo        example.main2

$ lanes link policy allow example.list_notes example.main
$ lanes link policy deny  gmail.send         gmail.main
```

Tightening is local and instant. **Widening a vendor scope needs browser re-consent** and goes
through `lanes link connect <connection> --add <bundle>` — that asymmetry is inherent to OAuth.

A rule naming an unknown connection is refused at write time, because a rule that silently grants
nothing looks identical to a working one until someone relies on it.

## Your own context

Memory, skills, and the vault are providers like any other — `lanes link connect memory`, `lanes link connect
skills`, `lanes link connect vault` — but they hold your material rather than an account, so they have a
control plane of their own. It reaches the same bytes an agent does.

```console
$ printf 'The deploy window is Thursday evening.' \
    | lanes link memory write deploy-window --title "Deploy window" --tag ops
$ lanes link memory list --tag ops
$ lanes link memory get deploy-window
$ lanes link memory forget deploy-window
```

An entry is one Markdown file with YAML frontmatter, so a text editor is an equally good client:
edit it in place and the next `memory.get` returns what you wrote. A file with no frontmatter at all
is an entry titled after its id.

```console
$ lanes link skills add review-diff --file review-diff.md    # or the document on stdin
$ lanes link skills list
$ lanes link skills show review-diff
$ lanes link skills remove review-diff
```

A skill becomes the MCP prompt `skills_<name>`. A running endpoint picks up a new one within a few
seconds — no restart. Agents can author skills too, under `skills.manage.*`, which is **not** in the
default bundle; `lanes link connect skills` grants it anyway, so narrowing it is one line:

```console
$ lanes link policy deny skills.manage.*
```

```console
$ printf %s "$GITHUB_PAT" | lanes link vault set github_token --description "GitHub PAT"
$ lanes link vault list                       # names and descriptions, never values
$ lanes link vault get github_token --show
$ TOKEN="$(lanes link vault get github_token --raw)"
$ lanes link vault remove github_token --yes
```

`lanes link vault get` prints a value; `lanes link secrets` never does. Those are the two kinds of secret
([`security.md`](security.md)): a credential authorises the system, and a vault item is yours.

A new item is **not readable over MCP until the endpoint restarts**, and it needs a grant naming it:

```console
$ lanes link policy allow vault.get.github_token
$ lanes link start                            # the item's capability exists from here on
```

That is deliberate — a write cannot hand itself a read, so granting access to a new secret is
something you do between two runs rather than something an agent does mid-session.

## Gate order

Failures surface in the cheapest place first:

```console
$ lanes link check     # static: schema, validation rules, no external calls
$ lanes link doctor    # read-only external: credentials resolve, database reachable
$ lanes link plan      # what reconcile would change; no mutation
$ lanes link start     # apply reconcile, then serve locally
$ lanes link deploy    # apply to the cloud target
```

`lanes link plan` exists specifically because reconcile disables undeclared connections, and that outcome
should never be a surprise.

## Deploying

The same config runs in more than one place; a target names an adapter set, and only the adapters
differ. [`docs/detailed/deployment-cloudrun.md`](deployment-cloudrun.md) is the full guide — the shape is:

```console
$ lanes link deploy --dry-run              # every gcloud command, none of them run
$ lanes link deploy                        # set up, build, push, roll a revision
$ lanes link connect gmail --target cloud  # a browser consent per account
$ lanes link deploy                        # again, so the revision sees them
$ lanes link outputs --target cloud        # the deployed URL an agent needs
```

`deploy` takes no `--target`: it deploys the target that has a deployment, and there is only ever
one worth meaning. The commands around it do take one, because `connect` and `outputs` are just as
usable against `local`.

The first `deploy` writes the target if there is not one, and creates the project resources it
names. `connect` comes after it rather than before, because a credential store it has not created
yet is not somewhere to write a credential — and the second `deploy` is what gets a revision to
reconcile the accounts you just authorised.

`lanes link secrets push --from local --to cloud` migrates a setup you already built locally,
instead of the `connect` step.

```console
$ lanes link secrets list --target cloud     # reference names only; no command prints a value
```

Credentials follow the target, because each target has its own credential store. `secrets push`
copies and never deletes, and skips a reference the destination already holds unless you pass
`--overwrite` — the deployed copy may be the newer one.

## Inspection

```console
$ lanes link status                          # connections, reachable capabilities, endpoint
$ lanes link audit tail --limit 25
$ lanes link audit tail --denied-only        # the interesting half
$ lanes link config show                     # the resolved config as JSON
$ lanes link token show --show
$ lanes link token rotate                    # invalidates every agent on this profile
```

`lanes link audit tail` shows both allowed and denied calls, with arguments redacted per the provider's
rules:

```
10:44:30  allow  example.echo      example.main  1ms  {"message":"hello"}
10:44:30  deny   example.set_note                0ms  {}
```

## Global flags

```
--profile <name>    overrides LANES_LINK_PROFILE and the workspace default
--target  <name>    overrides instance.default_target
--connection <id>   which memory/skills/vault connection, when a profile has several
--yes               skip the confirmation a destructive command would otherwise ask for
--port    <n>       override the configured port (start only)
--show              reveal a token or a vault value rather than truncating it
--raw               print only the value, for $(…) — no profile line, no styling
```

A command that reads a value takes it on **stdin**, never on argv, so it does not land in shell
history: `lanes link memory write`, `lanes link skills add`, `lanes link vault set`, and `lanes link secrets set` all work this way and
refuse rather than hang when stdin is a terminal.
