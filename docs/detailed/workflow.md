# Workflow

The normative CLI contract, in the order you meet it. Implement against this; keep it updated when a
command changes. To look one command up rather than follow the lifecycle, see
[`commands.md`](commands.md).

**Every command prints the resolved profile and target before acting**, read-only commands included.
It is the primary guard against operating on the wrong instance, and it costs one line.

```
profile personal  target local  /Users/you/.lanes-link
```

The parenthesised source matters: `profile: work` is much less useful than knowing it came from an
environment variable you forgot you exported.

## From nothing to a working endpoint

No external service and no credentials of any kind:

```console
$ lanes link profile add personal --target local
ok    created profile personal
      config   ~/.lanes-link/profiles/personal.yaml
      port     7337
      targets  local

Next: lanes link connect example --profile personal --target local

$ lanes link connect example --profile personal --target local
ok    connected example.main
      providers.example.enabled = true
      connections += example.main
      granted read bundle:
        + example.echo
        + example.get_note
        + example.list_notes

Next: lanes link start

$ lanes link start --profile personal --target local
profile personal  target local  ~/.lanes-link
  + example.main  create (active)
ok    reconciled
warn  minted a profile token — run: lanes link outputs --show
ok    serving http://127.0.0.1:7337/mcp
Ctrl-C to stop.
```

In another shell:

```console
$ lanes link outputs --profile personal --target local --show
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
$ lanes link connect example --profile personal --target local      # → example.main
$ lanes link connect example --profile personal --target local      # → example.main2
$ lanes link connect gmail --profile personal --target local        # → straight to the browser, nothing to register
$ lanes link connect gmail --profile personal --target local        # → again, another account
```

`lanes link connect gmail.main` re-authorises one existing account. `--id` overrides the derived connection
id; `--display-name` sets the label.

To see what one takes before starting — the console work, the values it will ask for, and whether
a browser is involved:

```console
$ lanes link setup plan --profile personal --target local               # every provider, connected or not
$ lanes link setup plan icloud_mail --profile personal --target local   # the steps, the values, the command
```

### Without a terminal to answer

`--non-interactive` never prompts. It resolves every value the manifest declares from the
credential store before writing anything, and refuses with what is missing and the command that
stores it:

```console
$ lanes link connect icloud_mail --profile personal --target local --id ada --non-interactive --json
{ "ok": false, "reason": "missing_credentials",
  "needs": [{ "ref": "icloud/ada",
              "command": "printf %s \"<username>:<password>\" | lanes link secrets set icloud/ada --profile personal" }],
  "then": "lanes link connect icloud_mail --profile personal --id ada --non-interactive" }

$ printf %s "ada@example.com:xxxx-xxxx-xxxx-xxxx" | lanes link secrets set icloud/ada
$ lanes link connect icloud_mail --profile personal --target local --id ada --non-interactive --json
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

$ lanes link start --profile personal --target local
ok    serving http://127.0.0.1:7337/mcp
      profiles: personal, work
```

Register it **once** — one URL, one token, both profiles ([ADR-009](adr/009-one-endpoint-per-workspace.md)):

```console
$ lanes link mcp add --profile personal --target local                 # every harness installed; or: lanes link mcp add codex
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

## Where a profile runs

A **target** names an adapter set — a credential store and a blob store, and optionally a
deployment. Connections, providers, policy and limits are declared once and apply to every target,
so moving between them changes where the bytes go and nothing above them.

```console
$ lanes link target list --profile personal
profile personal  target local  ~/.lanes-link

       cloud    gcp-secret-manager  gcs         cloudrun  my-service  europe-west1
       staging  gcp-secret-manager  gcs         —
  * →  local    file                filesystem  —

  *  instance.default_target — what commands run against
  →  what this shell resolves to right now
```

Two markers, because two things choose and they can disagree. `*` is the profile's
`instance.default_target`; `→` is what *this shell* resolves to, which `LANES_LINK_TARGET` or
`--target` may have moved. When they differ, the listing says which variable did it.

```console
$ lanes link target use cloud       # rewrite instance.default_target, for good
$ export LANES_LINK_TARGET=cloud    # or just for this shell
$ lanes link target show cloud --profile personal      # adapters, deployment, and the address it answers on
```

`target list` reads the file and asks nobody; `--urls` adds one platform lookup per deployable
target. `target show` always asks, because it is one target and you named it.

Note what `--target` does *not* do: it never points the CLI at a running endpoint. Every command
opens that target's stores directly, so `lanes link connect gmail --target cloud` runs the browser
consent on your machine and writes the refresh token into the deployment's credential store. The
deployed revision picks it up when it next boots, which is what the second `deploy` below is for.

## Selection

**Workspace root:** `LANES_LINK_HOME` → nearest ancestor containing `lanes-link.yaml` →
`~/.lanes-link`. This one still resolves, deliberately: getting it wrong yields "no profiles here"
rather than an action against the wrong account, and it is the only channel a container has for its
bucket.

**Profile and target:** `--profile` and `--target`, and nothing else (ADR-037). No environment
variable, no key in a file, no default. A command that names neither refuses and lists what there is
to choose from.

```console
$ lanes link status
error  --profile is required. Every command names the profile it acts on, and
       nothing else selects one.

         Profiles in ~/.lanes-link
           personal
           work
```

There used to be a chain — flag, then variable, then config key — and the argument for it was that
each step was *visible*: `env` shows a variable, `check` validates a key, and every command printed
which of the four it had landed on. What that missed is that a fallback makes an ignored flag
survivable. `lanes link profile add work --target cloud` dropped its flag, and the next command
carried on from a different source and worked, so the mistake surfaced one command later with
nothing connecting it to its cause. A command that refuses cannot be wrong quietly.

`instance.default_target` and `default_profile` are still parsed and no longer read. They stay
declared so `check` and `doctor` can tell you the line in front of you is inert, rather than the
schema dropping it and leaving you to believe it still selects something.

Three commands take no `--target`, and that is not an oversight. `check`, `config show` and
`policy list` are target-independent. `target list` is the command you run to find out what to
pass, so requiring the answer as input would be circular.

Typing it every time is the cost. A shell alias is the way to shorten it, and it is yours to write —
this is the one place the tool declines to remember something on your behalf.

## Permissions

```console
$ lanes link policy list --profile personal
Allow
  +  example.echo        example.main
  +  example.get_note    example.main

Deny
  A deny beats any allow, whatever the order in the file.
  -  example.echo        example.main2

$ lanes link policy allow example.list_notes example.main --profile personal --target local
$ lanes link policy deny  gmail.send         gmail.main --profile personal --target local
```

Tightening is local and instant. **Widening a vendor scope needs browser re-consent** and goes
through `lanes link connect <connection> --add <bundle>` — that asymmetry is inherent to OAuth.

A rule naming an unknown connection is refused at write time, because a rule that silently grants
nothing looks identical to a working one until someone relies on it.

## Your own context

Memory, tasks, assets, skills, and the vault are providers like any other, but they hold your
material rather than an account — so a profile arrives with all five declared and granted and there
is nothing to connect ([ADR-050](adr/050-the-owner-layer-is-granted-by-default.md)). Each has a
control plane of its own, reaching the same bytes an agent does.

Which store a thing goes in: **memory is what is true, tasks is what is to be done, assets is a
file.** Nothing refuses the wrong choice, which is why the rule is stated to agents as well as
here — [ADR-051](adr/051-tasks-and-assets-are-their-own-stores.md).

```console
$ printf 'The deploy window is Thursday evening.' \
    | lanes link memory write deploy-window --title "Deploy window" --tag ops
$ lanes link memory list --profile personal --target local --tag ops
$ lanes link memory get deploy-window --profile personal --target local
$ lanes link memory forget deploy-window --profile personal --target local
```

An entry is one Markdown file with YAML frontmatter, so a text editor is an equally good client:
edit it in place and the next `memory.get` returns what you wrote. A file with no frontmatter at all
is an entry titled after its id.

```console
$ lanes link skills add review-diff --profile personal --target local --file review-diff.md    # or the document on stdin
$ lanes link skills list --profile personal --target local
$ lanes link skills show review-diff --profile personal --target local
$ lanes link skills remove review-diff --profile personal --target local
```

A skill becomes the MCP prompt `skills_<name>`. A running endpoint picks up a new one within a few
seconds — no restart. Skills belong to the profile they were added under and no other sees them, so
`--profile work` is worth being deliberate about here. Agents can author skills too, under
`skills.manage.*`, which is **not** in the default bundle; the `skills.*` rule a profile is created
with grants it anyway, so narrowing it is one line:

```console
$ lanes link policy deny skills.manage.* --profile personal --target local
```

```console
$ printf %s "$GITHUB_PAT" | lanes link vault set github_token --description "GitHub PAT"
$ lanes link vault list --profile personal --target local                       # names and descriptions, never values
$ lanes link vault get github_token --profile personal --target local --show
$ TOKEN="$(lanes link vault get github_token --raw)"
$ lanes link vault remove github_token --profile personal --target local --yes
```

`lanes link vault get` prints a value; `lanes link secrets` never does. Those are the two kinds of secret
([`security.md`](security.md)): a credential authorises the system, and a vault item is yours.

A new item is **not readable over MCP until the endpoint restarts**, and it needs a grant naming it:

```console
$ lanes link policy allow vault.get.github_token --profile personal --target local
$ lanes link start --profile personal --target local                            # the item's capability exists from here on
```

That is deliberate — a write cannot hand itself a read, so granting access to a new secret is
something you do between two runs rather than something an agent does mid-session.

## Who you are

Names, addresses and handles to write as you, per profile. Optional — nothing needs them until
something writes as you and gets it wrong.

```console
$ lanes link identity add name "A. Lovelace" --note "use on anything published" --profile personal --target local
$ lanes link identity add name Ada --note "use for open-source work" --profile personal --target local
$ lanes link identity add email ada.lovelace@example.com --profile personal --target local
$ lanes link identity add github octocat --profile personal --target local
$ lanes link identity list --profile personal
$ lanes link identity remove name Ada --profile personal --target local
```

`identity list` takes no `--target`, for the reason `policy list` does not: the block is declared
once in the YAML and applies to every target the profile has. `add` and `remove` publish the edit,
so they name both.

`kind` is the first argument and is yours to choose: `name`, `email` and `github` are conventions,
not a list this project ships, so `linkedin`, `phone` or `pronouns` work with no code change. The
note is what makes several of a kind usable — it is read by whatever is deciding which one to use.
Order is the ranking, so the first of a kind is the default.

`identity` is the one owner-layer surface a profile does *not* arrive with, and that is deliberate:
a profile declaring no identity has nothing for the surface to report. The first `identity add`
writes the connection row and the `identity.*` grant for you, and says so.

```console
$ lanes link identity add name "A. Lovelace" --profile personal --target local
ok    name A. Lovelace
      connections += identity.main
      policy.allow += identity.*
      an agent can now read this profile’s identity
```

Both of those are needed before anything can read the block — a provider with no connection row is
filtered out before policy is consulted — so `identity list` warns when a hand-edited profile has
the entries and not the grant. Editing is CLI-only, deliberately: an agent able to change this
could change the one fact that stops it signing as the wrong person. What it gets is one read-only
tool, `identity_list`, and an instruction to call it rather than infer.

Nothing here belongs to a connection. An entry says *when* it applies in prose rather than naming
an account, so renaming a mailbox cannot break a profile.

## Gate order

Failures surface in the cheapest place first:

```console
$ lanes link check --profile personal     # static: schema, validation rules, no external calls
$ lanes link doctor --profile personal --target local     # external: credentials still authenticate, database reachable
$ lanes link auth --profile personal --target local       # just the credentials, per connection, as JSON
$ lanes link plan --profile personal --target local      # what reconcile would change; no mutation
$ lanes link start --profile personal --target local     # apply reconcile, then serve locally
$ lanes link deploy --profile personal --target local    # apply to the cloud target
```

`lanes link plan` exists specifically because reconcile disables undeclared connections, and that outcome
should never be a surprise.

## Deploying

The same config runs in more than one place; a target names an adapter set, and only the adapters
differ. [`docs/detailed/deployment-cloudrun.md`](deployment-cloudrun.md) is the full guide — the shape is:

```console
$ lanes link deploy --profile personal --target local --dry-run              # every gcloud command, none of them run
$ lanes link deploy --profile personal --target local                        # set up, build, push, roll a revision
$ lanes link connect gmail --profile personal --target cloud  # a browser consent per account
$ lanes link deploy --profile personal --target local                        # again, so the revision sees them
$ lanes link outputs --profile personal --target cloud        # the deployed URL an agent needs
```

`deploy` needs no `--target` when there is one deployment to mean: it deploys the target that has
one, creates `cloud` when none does, and *asks* rather than guessing when several do. Naming one is
how you deploy a second — see below.

The first `deploy` writes the target if there is not one, and creates the project resources it
names. `connect` comes after it rather than before, because a credential store it has not created
yet is not somewhere to write a credential — and the second `deploy` is what gets a revision to
reconcile the accounts you just authorised.

`lanes link secrets push --from local --to cloud` migrates a setup you already built locally,
instead of the `connect` step.

### More than one deployment

`cloud` is a target name, not a keyword — nothing in the code reserves it, and a profile may declare
as many deployable targets as you like. The second one is named on the deploy that creates it:

```console
$ lanes link deploy --profile personal --target staging      # surveys and writes targets.staging, then rolls it
$ lanes link target list --profile personal                  # what this profile declares, and which is in play
$ lanes link connect gmail --profile personal --target staging
$ lanes link outputs --profile personal --target staging
```

Once two targets declare a deployment, a bare `lanes link deploy` refuses and asks which you meant —
rolling a revision to whichever came first in a YAML mapping is the one answer that cannot be right
on purpose.

Each target has its own credential store, so a connection authorised against one is absent from the
other. `lanes link secrets push --from cloud --to staging` copies them instead of re-running every
consent.

### Which profiles a deploy uploads

One: the profile you named. `deploy` requires `--profile`, so the flag *is* the resolved profile and
the scope is never in doubt. It used to depend on how the profile had been resolved — the flag
uploaded one, a variable or a config default uploaded the whole workspace — which was documented as
surprising because it was.

A deploy also refuses if a profile it would upload does not declare the target being deployed. The
endpoint opens every profile in the bucket against one target, so one that cannot run there is not
skipped at boot — it is a revision that never goes healthy.

No credential ever travels — `data/` is never uploaded and each target has its own store, so a
connection you have not migrated reconciles as `unauthorized` rather than silently working.

```console
$ lanes link secrets list --profile personal --target local     # reference names only; no command prints a value
$ lanes link secrets push --profile personal --from local --to cloud
```

Credentials follow the target, because each target has its own credential store. `secrets push`
copies and never deletes, and skips a reference the destination already holds unless you pass
`--overwrite` — the deployed copy may be the newer one.

## The dashboard

Everything under *Inspection* below, on one page, for a local endpoint:

```console
$ lanes link dashboard              # opens a browser
$ lanes link dashboard --print      # prints the URL instead
```

It shows the connections and their reconciled state, every provider nothing is connected to, the
profiles this endpoint serves, and the targets the profile declares — with the one whose adapters
are open marked, and the others shown as declared but not served here.

**It renders commands; it does not run them.** A card for an unconnected provider carries the exact
`lanes link connect …` line, spelled with `--profile` and `--target` so the shell you paste it into
cannot resolve a different one than the page was describing. Connecting still happens in a terminal,
because the browser consent belongs to whoever owns the browser and the callback listener is the
CLI's ([ADR-005](adr/005-oauth-connection-flow.md)).

**Local only.** A browser navigation carries no `Authorization` header, and Cloud Run's own gate
admits only a Google-signed identity token that no browser will mint either — so a deployed instance
has no door this page could sit behind, and the container entrypoint never mounts it
([ADR-018](adr/018-the-gate-is-in-the-application.md)). Against a deployed target the command says
so and points at `lanes link status --target <name>`.

The link the command opens carries a one-time key, which the endpoint exchanges for a session cookie
and drops from the URL — so the token is not left in the address bar, the history, or a Referer.

## Inspection

```console
$ lanes link status --profile personal --target local                          # connections, reachable capabilities, endpoint
$ lanes link audit tail --profile personal --target local --limit 25
$ lanes link audit tail --profile personal --target local --denied-only        # the interesting half
$ lanes link config show --profile personal                     # the resolved config as JSON
$ lanes link token show --profile personal --target local --show
$ lanes link token rotate --profile personal --target local                    # invalidates every agent on this profile
$ lanes link version                         # which release this is
$ lanes link update --check                  # is a newer one published (exit 1 if so)
$ lanes link update                          # install it
```

`update` re-runs the global install, because that is all an update is: there is no build step, so
the `src/` inside the installed package is the code that runs. Bun is the only installer it drives.
From a checkout it refuses and says so — `git pull` is the update there. A running endpoint keeps
serving the old code until it is restarted.

`doctor`, `start`, and `deploy` each print one line when a newer release is out, and nothing when
the registry cannot be reached.

`lanes link audit tail` shows both allowed and denied calls, with arguments redacted per the provider's
rules:

```
10:44:30  allow  example.echo      example.main  1ms  {"message":"hello"}
10:44:30  deny   example.set_note                0ms  {}
```

## Flags

`--json`, `--quiet` and `--help` are accepted everywhere. Everything else belongs to the command that
reads it, and [`commands.md`](commands.md) lists them per command.

`--profile` and `--target` are not overrides: nothing else selects either one, so there is nothing
for them to override (ADR-037). The block that used to be here said they overrode
`LANES_LINK_PROFILE` and `instance.default_target`, which the Selection section above has been
contradicting since those stopped being read.

A command that reads a value takes it on **stdin**, never on argv, so it does not land in shell
history: `lanes link memory write`, `lanes link skills add`, `lanes link vault set`, and `lanes link secrets set` all work this way and
refuse rather than hang when stdin is a terminal. `lanes link tasks add` reads its notes the same
way but does not refuse, because they are optional — the title is the argument.
