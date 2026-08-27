# ADR-045: A provider may name the loopback redirect the vendor matches exactly

**Status:** accepted · **Relates to** [ADR-005](005-oauth-connection-flow.md) ·
**Amends** [ADR-033](033-a-pasted-token-for-an-mcp-server.md) ·
**Relates to** [ADR-040](040-an-mcp-connector-may-use-a-pre-registered-client.md)

## Context

`connect` runs the authorization code flow against a listener on `127.0.0.1`, bound to a port the
kernel picks (ADR-005). Nothing outside the machine names that port, so letting the OS choose it
avoids collisions for free.

That works because most authorization servers treat a loopback redirect as a special case and
match only the host and path, ignoring the port — which is what RFC 8252 §7.3 asks them to do.
Not all of them do. Some match `redirect_uri` as a whole string against what was registered in a
console, and for those the port chosen at runtime can never be the port registered months earlier.
The grant fails after consent with `redirect_uri_mismatch`, which reads as a broken client rather
than as a port that moved.

This was already costing us something. ADR-033 records GitHub reaching for a pasted token rather
than OAuth, and the reason given there is exactly this:

> an OAuth App matches its callback URL exactly, including the port, and `connect` listens on a
> port the kernel picks

That was true, and it was treated as a property of the CLI rather than as a gap in it.

ADR-040 solved an adjacent problem — Slack refuses a non-HTTPS redirect at all — by sending the
browser to the broker's HTTPS origin and carrying the loopback port in `state`. That answer does
not transfer. It requires a broker, and a broker is the wrong shape for a vendor that rate-limits
per client id: one shared client would pool every install into one budget.

## Decision

An OAuth provider may declare `auth.redirect_uri`. When it does, `connect` listens on the port
that URL names and hands the vendor that exact string.

- **The whole URL, not a port.** The two must be identical strings and only one of them is ours to
  choose. A console that accepts `localhost` but not `127.0.0.1`, or that wants a trailing path,
  decides the spelling — a manifest that could only name a number would have to guess the rest.
- **Mutually exclusive with `broker`.** Both answer "where does the browser come back to", and the
  flow reads one of them. `defineProvider` refuses a manifest declaring both.
- **A taken port is a refusal, not a crash.** With a kernel-chosen port `EADDRINUSE` cannot happen;
  with a fixed one it is the ordinary failure. The message names the port and says why it cannot
  simply be moved.

The listener is otherwise unchanged: same PKCE, same constant-time `state` check, same single
callback, same shutdown.

## Alternatives considered

**Register a range of ports and try each.** Some consoles accept several redirect URIs, so the CLI
could register ten and use whichever is free. It multiplies what the operator types by ten, and
the failure when all ten are busy is worse than the failure when one is.

**Always use a fixed port.** Simpler, and wrong: a fixed port can collide, and every provider that
does not need one would inherit that for nothing.

**Route everything through the broker, as ADR-040 does for Slack.** It works, and it makes a
shared client mandatory. For a vendor metering per client id that is a permanent cost paid to
avoid a one-time console visit.

## Consequences

- A vendor that pins its redirect is now reachable by OAuth. Reddit is the first, and GitHub could
  move off its pasted token on this basis — ADR-033's reasoning for that choice no longer holds,
  though the token still works and nothing forces the change.
- The operator types a URL into a console and it must match exactly. The provider's `setup.steps`
  states it verbatim, and `setup.troubleshooting` names `redirect_uri_mismatch` as the symptom.
- One more way for two manifest fields to disagree, which is why the mutual exclusion is checked
  at `defineProvider` rather than left for the flow to resolve by precedence.
