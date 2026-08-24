# Connecting Slack

Messages, threads, channels, files, and canvases, through the MCP server Slack
runs.

```
lanes link connect slack
```

You are asked for one user token. Getting that token means creating a Slack app
first, which is the one console visit left in this project — and unlike Google's,
it cannot be removed from your side.

## Why there is a console visit

Every other route is closed, and each for a different reason:

- **Dynamic Client Registration** — the mechanism that makes Notion and Linear
  cost nothing to connect. Slack's documentation is explicit: *"We do not
  support SSE-based connections or Dynamic Client Registration at this time."*
- **An OAuth client of your own** — the fallback used for Google. Slack requires
  redirect URIs to be **HTTPS**, and `connect` listens on `http://127.0.0.1` on
  a port the kernel picks per run. There is no flag, tunnel, or proxy that makes
  a loopback listener HTTPS.
- **A broker** — a client somebody else runs and performs the exchange behind.
  Refused at definition for an MCP provider, because the SDK owns that exchange
  and there is no seam to route it through one.

What is left is the arrangement Slack's own documentation describes for a client
that cannot register: install an app, take the user token, send it as
`Authorization: Bearer`. See
[ADR-033](../adr/033-a-pasted-token-for-an-mcp-server.md).

## Creating the app

1. Open **[api.slack.com/apps](https://api.slack.com/apps)** → **Create New App**
   → **From scratch**. Name it `Lanes Link` and pick your workspace.
2. Open **OAuth & Permissions** and scroll to **Scopes**.
3. Add the following under **User Token Scopes**. Not *Bot* Token Scopes — the
   MCP server reads the user token, and scopes added to the wrong list produce
   an app that installs cleanly and then refuses every call.

   | | Scopes |
   |---|---|
   | Search | `search:read.public` `search:read.private` `search:read.im` `search:read.mpim` `search:read.users` `search:read.files` |
   | Read messages | `channels:history` `groups:history` `im:history` `mpim:history` |
   | Channels and people | `channels:read` `groups:read` `mpim:read` `users:read` |
   | Send | `chat:write` |
   | Files | `files:read` |

   Optional, if you want those tools to work: `reactions:write` for reactions,
   `canvases:read` and `canvases:write` for canvases, `emoji:read` for emoji
   search, `channels:write` for creating channels. Slack lists every tool
   regardless of scope and refuses at call time, so a missing scope looks like a
   tool that exists and does not work.

4. Scroll back up and choose **Install to Workspace**, then approve. A workspace
   admin may have to approve it on your behalf.
5. Copy the **User OAuth Token** from the same page. It begins with `xoxp-`.

> The token beginning `xoxb-` on that page is the **bot** token. It is the more
> prominent of the two and it will not work here — a bot is a different identity
> with different visibility, and the MCP server expects yours.

The token goes into the encrypted credential store at `slack/<username>`, never
into config.

## What a user token means

It acts as **you**. Anything you can see in Slack — private channels you are in,
your DMs, your group DMs — is reachable through this connection, bounded by the
scopes above and by your Lanes Link policy, not by a separate permission model.
That is the point of a user token rather than a bot token, and it is also the
thing to be deliberate about.

Two consequences worth stating:

- **The token does not expire** unless you enable token rotation on the app.
  There is no refresh, so nothing renews it and nothing revokes it on a
  schedule. Revoking means uninstalling the app, or rotating it from
  **OAuth & Permissions**.
- **Narrowing is yours to do**, in two places. Fewer scopes at install time is
  the coarse control. `lanes link policy deny slack.send_message slack.<you>` is
  the fine one, and it is instant and local.

After rotating or reinstalling — either mints a new token — run:

```
lanes link connect slack --replace
```

Without `--replace`, connect finds the old token already stored and reuses it.

## Which account this is

The connection is labelled with your Slack **username**, read from
`auth.test`, rather than the workspace name. That matters if two people connect
Slack on the same machine: labelled by workspace, the second connection would
look like a reconnect of the first and overwrite their credential.

A quirk to know when something goes wrong: Slack answers a bad token with HTTP
`200` and `{"ok": false}` rather than a `401`, so a wrong token does not fail
the identity probe cleanly — you are asked "which account is this?" instead, and
the real error arrives a step later when discovery runs.

## Non-interactive

```console
$ printf %s "$SLACK_TOKEN" | lanes link secrets set slack/ada --profile personal
$ lanes link connect slack --id ada --non-interactive --json --profile personal
```

The credential goes in on stdin, never as a flag — an argument lands in shell
history, in `ps` output, and in any transcript.

## What is recorded

Where a message went is kept; what it said is not. An audit entry for
`send_message` records the channel, the thread, and whether it was broadcast,
and reduces `message` to a type marker — the same line Gmail draws for mail,
because it is the same object. `src/providers/slack/redact.ts` is the list, with
the reasoning for each.

`create_canvas` keeps nothing at all, and that is deliberate rather than an
omission: a canvas has no identifier until Slack answers with one, so its only
arguments are the title and the document. There is nothing to keep that is not
content.

One caveat, the same as GitHub's. A proxied server's capabilities are discovered
at connect time rather than declared here, so nothing in this repository can
check those argument names — unlike an `http` provider, where
`cli/tools.test.ts` does. They were read off the schemas Slack's server
publishes rather than guessed, but a rename upstream fails silently, with the
log reading exactly as it does when redaction is working. `lanes link doctor`
reporting capability drift is the signal that the list wants re-reading.

## Troubleshooting

**`Slack refused the token`** — nearly always one of three: a bot token
(`xoxb-`) pasted where the user token (`xoxp-`) belongs, a scope added under Bot
Token Scopes rather than User Token Scopes, or an app reinstalled since the
token was copied. Reinstalling mints a new one.

**A tool exists but every call fails** — a missing scope. Slack lists its whole
tool set regardless of what your token can do. Add the scope under User Token
Scopes, reinstall, and reconnect with `--replace`.

**The connection is labelled with something you typed** — the identity probe did
not get a username back, which for Slack means the token was refused. See the
quirk above.
