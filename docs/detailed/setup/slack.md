# Slack

```console
$ lanes link connect slack --profile personal --target local
```

A browser opens, you approve, and that is the whole of it. There is no Slack app to create, no
scope list to transcribe, and no token to copy.

## Why this used to cost a console visit

Slack does not support Dynamic Client Registration, so nothing can register itself with Slack the
way [Notion and Linear](../../connect.md) do. That is deliberate rather than missing: registering
dynamically would let a client authenticate someone without an app existing, and on Enterprise Grid
an admin approves each app before it can authenticate anyone.

So a client has to be pre-registered, and the question is only whose. It used to be yours. Now it
is one Lanes registered. What Lanes holds is the app's client secret; the browser still goes to
Slack, the consent is between you and your workspace, and the token lands in your credential store.

Slack also refuses to register a callback that is not HTTPS, and a command line cannot be HTTPS. So
Slack returns you to `api.lanes.sh`, which immediately redirects you back down to the command
waiting on your own machine. You will see it flicker past. Nothing is stored there — that hop
carries the same authorization code the exchange sends a moment later anyway.

The trade is written down in [`../security.md`](../security.md) under
`credentials.exchange-is-local`, and it is the same one Google's connection makes — with one
difference. A Google connection can opt out by registering your own client. A Slack one cannot: the
hosted client is also the HTTPS address Slack returns you to, so `lanes link connect slack` needs
it. Connections already made are unaffected if it is down, because Slack issues no refresh token and
nothing goes back afterwards.

## What it will ask for

`connect` prints the scopes before the browser opens and stops if you do not agree to them. They
are Slack **user-token** scopes: Slack's MCP server reads the user token, and a bot token is a
different credential that does not work there at all.

| Scope | What it means |
| --- | --- |
| `search:read.public`, `search:read.users`, `search:read.files` | Search public channels, people, files |
| `search:read.private`, `search:read.im`, `search:read.mpim` | Search private channels and DMs |
| `channels:history`, `channels:read` | Read and list public channels |
| `groups:history`, `groups:read` | Read and list private channels |
| `im:history`, `mpim:history`, `mpim:read` | Read direct and group direct messages |
| `users:read` | Read people and profiles |
| `files:read` | Read files and their contents |
| `chat:write` | Send messages **as you** |
| `reactions:write` | Add and remove reactions as you |
| `canvases:read`, `canvases:write` | Read and edit canvases |
| `channels:write` | Create and manage public channels |

Seven of those are flagged broad and need an explicit yes: the four that reach private
conversations, the two that search them, and `chat:write`. Slack draws no line between reading a
conversation and reading a private one, so a scope that reads like routine access is usually the
most sensitive thing in the workspace.

Granting a scope is not the same as letting an agent use it. `connect` grants the read bundle and
nothing else; `lanes link policy` is where the rest is turned on.

## If your workspace has not approved the Lanes app

An Enterprise Grid admin decides that, and you may not be able to change it. Use a token from an
app your workspace already trusts:

```console
$ lanes link connect slack --profile personal --target local --auth pasted_token
```

1. Open <https://api.slack.com/apps> and choose **Create New App** → **From scratch**. Name it and
   pick the workspace.
2. Open **OAuth & Permissions** and add the scopes you need under **User Token Scopes** — not Bot
   Token Scopes. The table above is the full set; a smaller set works, and the tools whose scope is
   missing fail when they are called rather than being hidden.
3. Choose **Install to Workspace** and approve. An admin may have to approve it for you.
4. Copy the **User OAuth Token**. It starts with `xoxp-`. The bot token starts with `xoxb-` and
   will not work here.

The token does not expire unless you enable token rotation on the app. If you rotate or reinstall,
the token changes:

```console
$ lanes link connect slack --profile personal --target local --auth pasted_token --replace
```

Two things are weaker on this path, and both are recorded in [`../security.md`](../security.md).
The stored value is the credential itself rather than a means of obtaining one, so rotating it is
manual. And there is no scope-disclosure gate: what the token can do was decided in your console
and cannot be read back, so `connect` records what it asked for rather than what it got.

## When it does not work

**"Slack refused the token."** Usually a bot token (`xoxb-`) where the user token (`xoxp-`) belongs,
a scope missing from **User Token Scopes**, or an app that has been reinstalled since — reinstalling
mints a new token.

**A tool is listed and fails when called.** Its scope was not granted. Re-run `lanes link connect
slack` to consent again, or add the scope in your own app if you took the pasted-token route.
