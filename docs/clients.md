# Add it to your agent

One endpoint, one token, every profile — so you register once per agent, not once per account.

| Client | Local | Your own cloud |
|---|---|---|
| [Claude Code](#claude-code) | `lanes link mcp add claude` | `lanes link mcp add claude --target cloud` |
| [Codex](#codex) | `lanes link mcp add codex` | `lanes link mcp add codex --target cloud` |
| [Claude Desktop, Cowork](#claude-desktop-and-cowork) | by hand — see below | it cannot be given a URL |
| [claude.ai](#claudeai-chatgpt-and-your-phone), [ChatGPT](#chatgpt), a phone | nothing there reaches your machine | a custom connector, by URL |
| [Anything else](#anything-else) | `lanes link outputs` | `lanes link outputs --target cloud` |

`lanes link mcp add` with no argument covers every agent it finds. It runs each one's own `mcp add`
rather than writing to its config file, because the registration format is the agent's business.
`lanes link mcp list` shows where you are registered.

## What the agent is told it is for

A registered endpoint is sixty tools and no account of what they are collectively for. Two things fix
that, and both are automatic.

**Every client gets the short version from the endpoint itself**, generated per connection from what
that client can actually reach — so it names your profiles and your connections and cannot go stale.
Nothing to install.

**Claude Code and Codex also get a skill file**, written by `lanes link mcp add` because neither has
a `skill add` command to delegate to:

| | Claude Code | Codex |
|---|---|---|
| skill | `~/.claude/skills/lanes-link/` | `~/.codex/skills/lanes-link/` |
| scout agent | `~/.claude/agents/` | — no subagents |

Re-run `mcp add` after an upgrade to refresh them; it reports `unchanged` when there was nothing to
do. `--no-skill` registers without writing anything.

## Claude Code

```console
$ lanes link mcp add claude --profile personal --target local       # user scope: your accounts are not one repository's tooling
```

Claude Code stores the token as a value, so after `lanes link token rotate` run `mcp add` again with
`--force`.

## Codex

```console
$ lanes link mcp add codex --profile personal --target local
$ export LANES_LINK_TOKEN="$(lanes link token show --raw)"   # put this in your shell profile
```

Codex stores the *name* of an environment variable and reads it at launch, so the token never
reaches `~/.codex/config.toml` and a rotation needs no re-registration. Nothing works until that
export is somewhere Codex will see it.

## Claude Desktop, and Cowork

Desktop cannot be pointed at a URL — its config validates every entry against `{ command, args?,
env? }`, and an entry carrying a `url` is silently dropped on launch. So Desktop spawns the endpoint
instead of connecting to it:

```json
{
  "mcpServers": {
    "lanes-link": {
      "command": "/Users/you/.bun/bin/lanes",
      "args": ["link", "mcp", "stdio", "--profile", "personal", "--target", "local"]
    }
  }
}
```

That goes in `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or
`%APPDATA%\Claude\claude_desktop_config.json` on Windows, beside whatever the file already holds.
Restart Desktop; it appears under Settings → Developer. One entry covers Cowork too.

Two things to get right:

- **Use an absolute path** — `which lanes` prints it.
- **`bun` must be on the `PATH` the client passes down.** `lanes` runs behind
  `#!/usr/bin/env bun`, so an absolute path to it is not enough on its own. Claude Desktop passes a
  `PATH` that includes `~/.bun/bin`, so the entry above works as written. If a client fails with
  `env: bun: No such file or directory`, name Bun yourself:
  `"command": "/Users/you/.bun/bin/bun", "args": ["run", "/path/to/link/src/cli/lanes.ts", "link", "mcp", "stdio", "--profile", "personal", "--target", "local"]`.

Three consequences of Desktop spawning the process:

- **No token needed.** The process is a child of the client, running as you, with no port for anyone
  else to reach.
- **`lanes link start` is not needed for it.** Run the endpoint for the clients that use HTTP.
- **The tool list is fixed for the session.** A skill added while Desktop is running appears next
  time it starts.

Both flags are required. This client spawns the endpoint rather than being pointed at a URL, so its
config file is the only place that can say which profile and target it serves — an entry without
them fails to start, and the reason appears in the client's MCP log.

This is a local registration with no deployed counterpart: a deployment is a URL, which is the one
thing this client cannot be given.

## claude.ai, ChatGPT, and your phone

These need a [deployment](deploy.md) — there is no address they can be given that reaches a laptop.

`cloud` in these commands is a target name — whatever your deployment is called. `lanes link target
list` shows yours.

Add a custom connector by URL, using the address `lanes link outputs --target cloud` prints. The
client registers itself, a browser opens on your endpoint's own approval page, and you paste that
target's token once — from `lanes link outputs --show --target cloud`. Same flow on a laptop and on a
phone.

**The token has to be the one that target's store holds.** Credentials are per target, and `outputs`
mints a fresh token when the store is empty rather than saying so — so a target whose secrets were
never pushed hands you one the deployed endpoint has never seen, and the approval page answers *"That
token was not accepted"* with nothing pointing at why. `lanes link secrets push --from local --to
cloud` is what fills it.

If a connector reports the server as unreachable, three documents are how it learns it needs a token.
Read them in order; the first that does not answer is the problem:

```console
$ curl -i -X POST https://…run.app/mcp | head -3          # 401, with resource_metadata
$ curl -s https://…run.app/.well-known/oauth-protected-resource | jq
$ curl -s https://…run.app/.well-known/oauth-authorization-server | jq
```

### ChatGPT

Its connector UI is off by default and the setting is not where an older walkthrough will send you:
Connectors was renamed Plugins, so there is no longer a Connectors → Advanced to find.

1. **Settings → Security and login → Developer mode**, on. Plus, Pro, Business, Enterprise or Edu,
   and web only — a free account cannot.
2. **Plugins → `+` → New Plugin.** Name it; the icon and description are optional.
3. **Connection** is **Server URL** — Tunnel is for a server on your own machine, which this is not.
   Paste the `/mcp` address, with the path: it is what the endpoint names as the protected resource,
   and the bare origin is a different string.
4. **Authentication** is **OAuth**. There is nowhere to paste a bearer token, and *No authentication*
   gets a 401.
5. **Open Advanced OAuth settings.** Discovery runs from this panel, and leaving it unopened is
   enough to make Create do nothing at all. Choose **dynamic client registration**, leave the client
   id and secret empty, and take `mcp offline_access` as the scopes. Nothing has to be typed if
   discovery filled it in.
6. Tick the risk checkbox and **Create**, then connect. Your endpoint's own approval page opens,
   naming `chatgpt.com` as where the code goes — worth recognising, since registration is open by
   design and a client may call itself anything. Paste the token.
7. Enable the plugin in the composer. Individual tools can be switched off on its own page.

Nothing has to be entered by hand: `offline_access` is what keeps the connector signed in, and this
endpoint registers clients dynamically, so there is no OAuth client to create and no redirect URI to
register anywhere.

**After `lanes link connect` adds an account, refresh the plugin.** This endpoint promises no
`listChanged` notification — it cannot keep one, being stateless ([ADR-032](detailed/adr/032-a-stateless-endpoint-does-not-announce-its-tools.md))
— so a client that does not ask again keeps the tool list it first saw. A connected account that
never appears is this, not a broken deployment.

### When a working connector drops

A connector that *was* working and then reports the server as unreachable — or asks to be
authorised again — is one of four things, and the endpoint's own log separates them. Read the
minute it happened:

| In the log | What it was |
|---|---|
| `rejected request {"reason":"missing"}` | the client sent no credential. It discarded its own, or is starting discovery |
| `rejected request {"reason":"invalid"}` | it sent one this endpoint does not know |
| `warn refresh token replayed` | a second copy of the client presented a spent refresh token. Refused, and the live session is untouched — see [ADR-035](detailed/adr/035-a-replayed-refresh-token-must-not-log-the-owner-out.md) |
| **nothing at all** | the call never left the client |
| a browser prompt with no `/token` line | the client's refresh failed at the network level. It is swallowed rather than surfaced, so a re-authorization appears with no error behind it |

The last row is the one worth knowing, because from the outside it looks exactly like the others
and it is the only one where the endpoint is not involved. No line means no request: no cold
start, no timeout, no refusal. The connector decided by itself that this endpoint was
unavailable. Reconnect it — there is nothing here to change.

Ruling that out first is worth the one query it costs:

```console
$ gcloud logging read \
    'resource.labels.service_name="<service>" AND timestamp>="2026-01-01T09:00:00Z"' \
    --project <project-id> --limit 50 \
    --format='value(timestamp, textPayload, httpRequest.status, httpRequest.requestUrl)'
```

A deployment scaling to zero is not this. It shuts down and restarts many times a day, requests
queue behind the boot, and a cold start is a couple of seconds — visible in the latency column,
not as a failure.

## Anything else

```console
$ lanes link outputs --profile personal --target local --show
Endpoint
  http://127.0.0.1:7337/mcp  running
Token
  llk_…
```

Any client that speaks streamable HTTP MCP with a static `Authorization: Bearer` header can be
pointed at those two values. `--target cloud` prints the deployed pair instead.

---

**Full reference:** [`detailed/adr/016-what-the-endpoint-says-about-itself.md`](detailed/adr/016-what-the-endpoint-says-about-itself.md)
covers what a client is told and which of its files Lanes Link writes.
