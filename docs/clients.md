# Add it to your agent

One endpoint, one token, every profile — so you register once per agent, not once per account.

| Client | Local | Your own cloud |
|---|---|---|
| [Claude Code](#claude-code) | `lanes link mcp add claude` | `lanes link mcp add claude --target cloud` |
| [Codex](#codex) | `lanes link mcp add codex` | `lanes link mcp add codex --target cloud` |
| [Claude Desktop, Cowork](#claude-desktop-and-cowork) | by hand — see below | it cannot be given a URL |
| [claude.ai, ChatGPT, a phone](#claudeai-chatgpt-and-your-phone) | nothing there reaches your machine | a custom connector, by URL |
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
$ lanes link mcp add claude       # user scope: your accounts are not one repository's tooling
```

Claude Code stores the token as a value, so after `lanes link token rotate` run `mcp add` again with
`--force`.

## Codex

```console
$ lanes link mcp add codex
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
      "args": ["link", "mcp", "stdio"]
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
  `"command": "/Users/you/.bun/bin/bun", "args": ["run", "/path/to/link/src/cli/lanes.ts", "link", "mcp", "stdio"]`.

Three consequences of Desktop spawning the process:

- **No token needed.** The process is a child of the client, running as you, with no port for anyone
  else to reach.
- **`lanes link start` is not needed for it.** Run the endpoint for the clients that use HTTP.
- **The tool list is fixed for the session.** A skill added while Desktop is running appears next
  time it starts.

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

If a connector reports the server as unreachable, three documents are how it learns it needs a token.
Read them in order; the first that does not answer is the problem:

```console
$ curl -i -X POST https://…run.app/mcp | head -3          # 401, with resource_metadata
$ curl -s https://…run.app/.well-known/oauth-protected-resource | jq
$ curl -s https://…run.app/.well-known/oauth-authorization-server | jq
```

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
$ lanes link outputs --show
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
