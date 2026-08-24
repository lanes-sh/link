# Connecting GitHub

Repositories, issues, pull requests, and workflow runs, through the MCP server
GitHub runs.

```
lanes link connect github
```

You are asked for one fine-grained personal access token. There is no browser
consent, no OAuth client, and nothing to register.

## Why a token rather than OAuth

Every other MCP-proxied provider here signs in through a browser. Notion and
Linear support Dynamic Client Registration, so Lanes Link registers itself with
their authorization server at connect time and the operator does nothing at all.

GitHub does not offer that yet. The documented alternative — register an OAuth
App or GitHub App of your own — fails on a detail that has nothing to do with
GitHub's intent: an OAuth App matches its callback URL exactly, port included,
and `connect` listens on `127.0.0.1` on a port the kernel picks per run. There
is no port to register.

GitHub's remote MCP server accepts a personal access token as
`Authorization: Bearer`, which is the credential GitHub issues for exactly this
case. See [ADR-033](../adr/033-a-pasted-token-for-an-mcp-server.md).

## The token

1. Open **[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)**
   and choose **Generate new token**.
2. Name it `Lanes Link`. The name is how you revoke this one later without
   touching your other tokens. Set an expiry you are willing to renew.
3. **Resource owner** — yourself, or the organisation whose repositories you
   want reachable. An organisation may require an owner to approve the token
   before it does anything, and until they do it authenticates and returns
   nothing.
4. **Repository access** — only the repositories you want an agent to see.
   *All repositories* is the setting people regret.
5. **Permissions**, matching the toolsets this connects:

   | Permission | Level |
   |---|---|
   | Contents | Read |
   | Metadata | Read *(added for you)* |
   | Issues | Read and write |
   | Pull requests | Read and write |
   | Actions | Read |

   Add *Administration* or *Workflows* only if you know you need them.
6. **Generate**, then copy the token. GitHub shows it once, and it starts with
   `github_pat_`.

A classic token works too, with the `repo` scope, but it is all-or-nothing
across every repository you can reach. Prefer the fine-grained one.

The token goes into the encrypted credential store at `github/<login>`, never
into config.

## Renewing it

A fine-grained token expires. When it does, generate another and run:

```
lanes link connect github --replace
```

Without `--replace`, connect finds the expired token already stored and reuses
it. This is the same shape as iCloud's app-specific password, and for the same
reason: the stored credential is the one that was just refused, so every other
spelling of the command reuses it.

## Which tools you get

GitHub serves a different tool list per *toolset*, and this connection asks for
`context`, `repos`, `issues`, `pull_requests`, `actions`, and `labels` — what an
agent working in a repository actually uses. The full set is considerably
larger and is more than most agents reason over well.

If you want a narrower connection, GitHub also serves a read-only variant. It is
a manifest of your own rather than a flag:

```yaml
# ~/.lanes-link/data/<profile>/providers.d/github-readonly.yaml
id: github_readonly
name: GitHub (read-only)
connector:
  kind: mcp
  endpoint: https://api.githubcopilot.com/mcp/readonly
auth:
  kind: bearer
identity:
  kind: http
  url: https://api.github.com/user
  field: login
setup:
  prompts:
    - key: token
      label: GitHub personal access token
      secret: true
      scope: connection
```

That is a separate provider with its own token and its own policy line, which is
the point — you can grant one profile the read-only connection and never the
other.

## Non-interactive

GitHub is the straightforward case for an agent with a shell, because nothing
here needs a browser:

```console
$ printf %s "$GITHUB_TOKEN" | lanes link secrets set github/octocat --profile personal
$ lanes link connect github --id octocat --non-interactive --json --profile personal
```

The credential goes in on stdin, never as a flag — an argument lands in shell
history, in `ps` output, and in any transcript.

## What is recorded

Reads are logged with every argument reduced to a type marker, which is the
right default for a server whose capabilities we did not author. Writes keep
their identifiers and withhold your words: an entry says which issue in which
repository was closed, and by what method, and does not keep the body you typed.
`src/providers/github/redact.ts` is the list, with the reasoning.

One caveat stated rather than left to be discovered. Those argument names come
from GitHub's published tool documentation, because a proxied server's
capabilities are discovered at connect time rather than declared here — so
unlike an `http` provider, nothing in this repository can check them. If GitHub
renames an argument, the value is withheld and the log reads exactly as it does
when redaction is working. `lanes link doctor` reporting capability drift is the
signal that the list wants re-reading.

## Troubleshooting

**`GitHub refused the token`** — usually one of three things: the token expired,
the repository was not in the set you granted, or an organisation token is still
waiting on an owner's approval.

**The connection is labelled with something you typed rather than your login** —
the identity probe could not reach `api.github.com/user`, which nearly always
means the token is wrong. Discovery fails a moment later with the real error.

**A tool you expected is missing** — check the toolsets above. `lanes link status`
lists what this connection actually discovered.
