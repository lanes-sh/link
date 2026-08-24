# Quickstart

From nothing to an endpoint your agents can use. Steps 1 to 5 need no external service, no
credentials, and no account anywhere — the first thing that costs any setup is step 6.

You need [Bun](https://bun.com) 1.3.11+. There is no build step.

## 1. Install

```console
$ bun install -g @lanes-sh/link
$ lanes --version             # confirms it landed on your PATH
```

Check that second line. Several registration commands read your token with `$(lanes link token show
--raw)`, and without `lanes` on your `PATH` that substitutes to an empty string — the only symptom
is a 401 that looks like a bad token.

Working on Lanes Link itself rather than using it? A checkout and `bun link` put the same command on
your `PATH`: [`detailed/local-development.md`](detailed/local-development.md).

## 2. Create a profile

A profile is one set of accounts with one set of permissions. Most people start with one.

```console
$ lanes link profile add personal --default
ok    created profile personal
      config  ~/.lanes-link/profiles/personal.yaml
      port    7337
      set as the workspace default
```

## 3. Add your own context

Memory, skills, and the vault hold your material rather than an account, so they need no credential
and no browser. One command each:

```console
$ lanes link connect memory
ok    connected memory.main
      connections += memory.main (Memory)
      policy.allow += memory.*
      5 capabilities discovered, all reachable
      2 of them write — lanes link policy deny memory.<capability> to withhold one

$ lanes link connect skills
$ lanes link connect vault
```

`connect` takes one provider at a time. Connecting grants that provider's whole namespace, write
half included — `lanes link policy deny memory.write` narrows it.

All three belong to the profile you ran them under. A second profile starts empty and stays that
way: nothing you store in one is visible from another.

## 4. Start the endpoint

```console
$ lanes link start
profile personal (workspace-default)  target local (config-default)  ~/.lanes-link
  + setup.main  create (active)
  + memory.main  create (active)
ok    reconciled
warn  minted a token — run: lanes link outputs --show
ok    serving http://127.0.0.1:7337/mcp
      profiles: personal
Ctrl-C to stop.
```

Leave it running. The token is minted on that first start and is what your agents authenticate with;
the next step hands it over for you.

Every command prints the profile and target it resolved before it acts — that first line is how you
know you are operating on the instance you meant.

A **target** is where the profile runs: `local` keeps credentials in an encrypted file and data in a
directory, and a deployed target keeps them in your cloud instead. Everything above them —
connections, permissions, limits — is declared once and applies to both. `lanes link target list`
shows what you have.

## 5. Register it with your agents

In another shell:

```console
$ lanes link mcp add          # every agent installed; or name one: claude, codex
ok    registered lanes-link with Claude Code (user scope)
      installed skill at ~/.claude/skills/lanes-link/SKILL.md
      installed scout agent at ~/.claude/agents/lanes-link-scout.md
ok    registered lanes-link with Codex
      installed skill at ~/.codex/skills/lanes-link/SKILL.md
```

One endpoint, one token, every profile — so you register once per agent, not once per account.

Codex needs one more line, and Claude Desktop is set up by hand because it cannot be given a URL.
See [Add it to your agent](clients.md).

## 6. Connect your first account

A mail or calendar account is the first thing that costs any setup:

```console
$ lanes link connect gmail
```

That opens a browser and nothing else — Google authorises against the OAuth client Lanes operates,
so there is no Cloud project to create. See [Connect your accounts](connect.md) for every provider,
what each one needs, and how to use an OAuth client of your own instead.

A new connection is served straight away — `connect` tells the running endpoint to re-read its
config, so there is nothing to restart. It prints which happened on its last line; if no endpoint
was running, the connection is saved and served when you next start one.

## 7. Check what you have

```console
$ lanes link status                 # connections, reachable capabilities, endpoint
$ lanes link audit tail --limit 25  # what your agents have actually done
$ lanes link policy list            # what they are allowed to do
```

Ask an agent to search your mail. If it is refused, that is the permission system working — run
`lanes link policy list` and widen it deliberately.

## Two profiles side by side

Work and personal never share a credential store, a state store, or an audit log:

```console
$ lanes link profile add work
$ lanes link --profile work connect notion
$ lanes link start
ok    serving http://127.0.0.1:7337/mcp
      profiles: personal, work
```

One endpoint serves both, and each call names the profile it means. They do share that endpoint's
token, so an agent holding it can reach either by asking. If you need a boundary that holds against
the agent itself, use a second workspace.

---

**Full reference:** [`detailed/workflow.md`](detailed/workflow.md) covers every command, the
resolution order for profiles and targets, and the gate order (`check` → `doctor` → `plan` →
`start`).
