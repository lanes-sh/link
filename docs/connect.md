# Connect your accounts

Each account is one connection, with its own credential, its own permissions, and its own label. Run
`lanes link connect <provider>` once per account you want reachable.

```console
$ lanes link connect gmail        # prompts for a client id/secret once, then a browser
$ lanes link connect gmail        # straight to the browser, a second mailbox
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
| Gmail (Google MCP) | `lanes link connect gmail_mcp` | Google's own MCP server — Developer Preview only |
| Drive (Google MCP) | `lanes link connect drive_mcp` | Likewise; use `drive` unless you are enrolled |

## Three things the table does not show

**Each Google product is its own connection.** Connecting Gmail does not imply Drive, Sheets, Docs,
Calendar, Tasks, or Contacts — each holds its own token under its own scopes. One OAuth client
covers all seven, so adding the second costs no new credentials, but each needs its API enabled and
its scopes registered. `lanes link connect` prints that console work the first time you connect each
product. Full walkthrough: [`detailed/setup/google.md`](detailed/setup/google.md).

**`lanes link connect icloud` sets up Mail, Calendar, and Contacts together**, because one
app-specific password covers all three. iCloud Drive is separate — it holds no credential at all,
reading your sync folder through the filesystem. Full walkthrough:
[`detailed/setup/icloud.md`](detailed/setup/icloud.md).

**Only Google needs an OAuth client you register yourself.** Notion and Linear register themselves,
and iCloud takes an app-specific password you generate at appleid.apple.com.

## See what one takes before you start

```console
$ lanes link setup plan               # every provider, connected or not
$ lanes link setup plan icloud_mail   # the steps, the values it will ask for, the command
```

An agent connected to your endpoint can see the same thing, so it can hand you the exact command
instead of guessing at one. That surface is read-only: connecting, credentials, and permissions stay
in this CLI.

## Permissions

Connecting grants a read bundle. Tightening is instant and local:

```console
$ lanes link policy list
$ lanes link policy deny gmail.send gmail.main
```

A deny beats an allow whatever the order in the file. Widening a vendor scope is different — it
needs browser re-consent, through `lanes link connect <connection> --add <bundle>`.

## Connecting without a terminal to answer

For providers whose credential is a key or a password rather than a browser sign-in, an agent with a
shell can do the whole setup:

```console
$ printf %s "$KEY" | lanes link secrets set linear/main --profile personal
$ lanes link connect linear --id main --non-interactive --json --profile personal
```

`--non-interactive` never prompts. It resolves every value from the credential store, or refuses and
prints exactly what is missing and the command that stores it. Anything needing a browser consent is
refused outright rather than opening one nobody is watching.

Credentials go in on stdin, never as a flag — an argument lands in your shell history, in `ps`
output, and in any transcript.

## Add your own

Any MCP server, any REST API with an OpenAPI spec, any IMAP mailbox, any CalDAV or CardDAV server.
Most are a fifteen-line YAML manifest in `~/.lanes-link/providers/` and no code at all. See
[`detailed/creating-a-provider.md`](detailed/creating-a-provider.md).

---

**Full reference:** [`detailed/providers.md`](detailed/providers.md) lists every capability, why it
is a tool or a resource, and what its audit entries keep and withhold.
