# Connect your accounts

Each account is one connection, with its own credential, its own permissions, and its own label. Run
`lanes link connect <provider>` once per account you want reachable.

```console
$ lanes link connect gmail --profile personal --target local        # straight to the browser, nothing to register
$ lanes link connect gmail --profile personal --target local        # again, for a second mailbox
```

`lanes link status` shows what is connected and what that makes reachable.

## What you can connect

| | Connect with | What it gives your agent |
|---|---|---|
| Gmail | `lanes link connect gmail` | Read, search, send, draft, and organise mail |
| Google Drive | `lanes link connect drive` | Search, read, export, and share files |
| Google Sheets | `lanes link connect sheets` | Read and edit cells, ranges, and tabs |
| Google Docs | `lanes link connect docs` | Read a document and edit its content |
| Google Calendar | `lanes link connect calendar` | Read and write events, and answer when you are free |
| Google Tasks | `lanes link connect tasks` | Create, edit, complete, and reorder tasks |
| Google Contacts | `lanes link connect contacts` | Look up an address, so "email Bob" resolves. Read-only |
| iCloud Mail | `lanes link connect icloud_mail` | Read, search, and send over IMAP and SMTP |
| iCloud Calendar | `lanes link connect icloud_calendar` | Read and write events over CalDAV |
| iCloud Contacts | `lanes link connect icloud_contacts` | Look up an address over CardDAV |
| iCloud Drive | `lanes link connect icloud_drive` | Your sync folder, on the Mac that syncs it |
| Notion | `lanes link connect notion` | Notion's own MCP server |
| Linear | `lanes link connect linear` | Linear's own MCP server |
| GitHub | `lanes link connect github` | Repositories, issues, pull requests, and workflow runs |
| Slack | `lanes link connect slack` | Search, read, and send messages, threads, files, and canvases |
| Reddit | `lanes link connect reddit` | Read subreddits and comments, search, and post, comment, and vote as you |
| Gmail (IMAP) | `lanes link connect gmail_imap` | The same mailbox over IMAP and SMTP, with an app password that does not expire |
| Gmail (Google MCP) | `lanes link connect gmail_mcp` | Google's own MCP server — Developer Preview only |
| Drive (Google MCP) | `lanes link connect drive_mcp` | Likewise; use `drive` unless you are enrolled |
| bunq | `lanes link connect bunq` | Accounts, balances, transaction history, and payments |

## Four things the table does not show

**Each Google product is its own connection.** Connecting Gmail does not imply Drive, Sheets, Docs,
Calendar, Tasks, or Contacts — each holds its own token under its own scopes. One OAuth client
covers all seven, so adding the second costs no new credentials, but each needs its API enabled and
its scopes registered. `lanes link connect` prints that console work the first time you connect each
product. Full walkthrough: [`detailed/setup/google.md`](detailed/setup/google.md).

**`lanes link connect icloud` sets up Mail, Calendar, and Contacts together**, because one
app-specific password covers all three. iCloud Drive is separate — it holds no credential at all,
reading your sync folder through the filesystem. Full walkthrough:
[`detailed/setup/icloud.md`](detailed/setup/icloud.md).

**bunq can move money, and nothing asks you to confirm.** Its payment tool executes immediately
and is not reversible — there is no approval step in the bunq app or anywhere else. Set a spending
limit on the API key, and if you want an agent to prepare payments rather than make them, deny the
two payment tools **and** `UPDATE_DraftPayment` — accepting a draft is itself how a draft is spent,
so leaving that one allowed lets an agent approve its own. Read
[`detailed/setup/bunq.md`](detailed/setup/bunq.md) before connecting it; it is the only page here
that is mostly about what not to do.

**Only GitHub and bunq ask you to register anything.** Google and Slack authorise against the client Lanes
operates, Notion and Linear register themselves, and iCloud takes an app-specific password you
generate at appleid.apple.com. GitHub takes a personal access token you create once —
[`detailed/setup/github.md`](detailed/setup/github.md) — and bunq takes an API key you generate in
the bunq app, which is also where you set its spending limit.

Slack used to be on that list and no longer is. Slack does not register clients automatically and
is not going to — it would let a client authenticate someone without an app existing, and on
Enterprise Grid an admin approves each app first. What changed is whose app it is: Lanes registered
one, so `lanes link connect slack` is a browser round trip like the rest.

If your workspace has not approved that app — which an admin decides, not you — paste a token from
one it already trusts instead:

```console
$ lanes link connect slack --profile personal --target local --auth pasted_token
```

[`detailed/setup/slack.md`](detailed/setup/slack.md) covers both.

For Google you can still register your own, and some people have to — an organisation that forbids
third-party clients, a Workspace app that must be "Internal", or a hosted client that has reached
its account limit:

```console
$ lanes link connect gmail --profile personal --target local --own-client
```

That walks through the Google Cloud console once, stores the client id and secret, and records the
choice in your profile, so every later Google connection on that profile uses your client without
the flag. See [`detailed/setup/google.md`](detailed/setup/google.md) for the walkthrough and what
the two paths trade against each other.

## When the connection starts working

As soon as `connect` finishes. It saves the connection, copies the config to wherever the target's
endpoint reads it, and asks that endpoint to re-read it — so a running `lanes link start` picks it
up without a restart, and a deployed endpoint picks it up without a new revision. Deploying is how
new code gets to an endpoint; authorising an account changes no code (ADR-029).

The last line says which happened, and how many tools the endpoint now advertises:

```console
Next: Serving it now — the endpoint has re-read its config.
  42 tools are advertised now. A client connected before this keeps the
  list it already fetched — reconnect it to pick them up.
```

If no endpoint was running, or this machine cannot reach a deployed one, it says that instead. The
connection is saved either way and is served the next time that endpoint starts.

## Your agent needs reconnecting, though

An MCP client reads the tool list when it connects and keeps it. This endpoint cannot tell it
otherwise — it holds no session, so there is no channel to send a change on, and it says as much
rather than claiming there is (ADR-032). So a client registered before this connection still shows
the tools it saw then.

Remove and re-add it. For a hosted connector that is Disconnect and add the URL again; for a local
one, whatever your agent's equivalent is.

To see what a client would be handed right now:

```console
$ lanes link tools --profile personal --target local                # names by provider, payload size
$ lanes link tools --profile personal --target cloud # ask the deployed endpoint instead
```

If that count matches your client, its tools are current. If it does not, the client is holding an
old list and reconnecting is the fix.

Tools only, though. A skill is a *prompt*, not a tool, so adding one moves neither the count nor
the line `connect` prints — and skills are picked up by a running endpoint without a reload, so
nothing announces them either. After `lanes link skills add`, reconnect the client on the same
reasoning and without waiting for a number to change.

## See what one takes before you start

```console
$ lanes link setup plan --profile personal --target local               # every provider, connected or not
$ lanes link setup plan icloud_mail --profile personal --target local   # the steps, the values it will ask for, the command
```

An agent connected to your endpoint can see the same thing, so it can hand you the exact command
instead of guessing at one. That surface is read-only: connecting, credentials, and permissions stay
in this CLI.

## Permissions

Connecting grants a read bundle. Tightening is instant and local:

```console
$ lanes link policy list --profile personal
$ lanes link policy deny gmail.send gmail.main --profile personal --target local
```

A deny beats an allow whatever the order in the file. Widening a vendor scope is different — it
needs browser re-consent, through `lanes link connect <connection> --add <bundle>`.

## Connecting without a terminal to answer

For providers whose credential is a key or a password rather than a browser sign-in, an agent with a
shell can do the whole setup:

```console
$ printf %s "$TOKEN" | lanes link secrets set github/octocat --profile personal
$ lanes link connect github --id octocat --non-interactive --json --profile personal
```

`--non-interactive` never prompts. It resolves every value from the credential store, or refuses and
prints exactly what is missing and the command that stores it. Anything needing a browser consent is
refused outright rather than opening one nobody is watching.

Credentials go in on stdin, never as a flag — an argument lands in your shell history, in `ps`
output, and in any transcript.

## Add your own

Any MCP server, any REST API with an OpenAPI spec, any IMAP mailbox, any CalDAV or CardDAV server.
Most are a fifteen-line YAML manifest in `~/.lanes-link/data/<profile>/providers.d/` and no code at all. See
[`detailed/creating-a-provider.md`](detailed/creating-a-provider.md).

---

**Full reference:** [`detailed/providers.md`](detailed/providers.md) lists every capability, why it
is a tool or a resource, and what its audit entries keep and withhold.
