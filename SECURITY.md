# Security policy

Lanes Link holds live credentials to its owner's email and documents. Vulnerability reports are
taken seriously.

## Reporting

**Please do not open a public issue for a vulnerability.**

Use GitHub's private reporting: **Security → Report a vulnerability** on
<https://github.com/lanes-sh/link>. If that is unavailable to you, open an issue asking for a private
channel without including any details.

Please include what you can: affected version or commit, what an attacker achieves, and a
reproduction. A proof of concept is welcome but not required.

## Scope

In scope: anything letting a caller reach a connection it holds no grant for, read a credential,
escape a profile or connection boundary, reach a control-plane operation through MCP, or defeat audit
recording.

Explicitly **out of scope**, because they are documented properties rather than defects — see
[the security model](https://lanes.sh/docs/link/security):

- Provider code doing anything its own connection's credential permits. Provider code is trusted and
  there is no sandbox.
- Credentials being readable in the memory of a running process.
- Anyone holding the profile bearer token acting as that profile.
- Rate limits not being global across horizontally scaled instances.
- Prompt injection in content returned from an upstream account. Content is passed through
  unscreened, by design.
- Mail attachments reading any file the endpoint's own user can read. `path` is deliberately
  unrestricted — no allowlist, no confinement to a root (ADR-017) — so an agent that has been
  prompt-injected can attach anything that user could open, including this workspace. What makes
  that defensible is the record rather than a sandbox: every resolved attachment is logged with its
  origin and a SHA-256 before the message is submitted, so *was this file ever mailed out* stays an
  answerable question. Run the endpoint as a user whose files you are willing to treat that way.

If you are unsure whether something is in scope, report it.

## Supply chain

Dependency compromise is a live threat for a project holding long-lived credentials.
`bunfig.toml` sets a seven-day `minimumReleaseAge`, so a version published and yanked within hours
cannot enter the lockfile. `bun run audit` resolves the lockfile against npm's advisory database and
runs in CI. The deployed image's base is pinned by digest, not only by tag. Reports about a
dependency are welcome; please also report them upstream.
