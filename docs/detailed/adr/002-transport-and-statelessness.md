# ADR-002: Stateless streamable HTTP on MCP SDK v2

**Status:** accepted · **Milestone:** M1

## Decision

Serve stateless streamable HTTP on a single `/mcp` endpoint, built on **MCP TypeScript SDK v2**
speaking protocol revision **`2026-07-28`**.

```
@modelcontextprotocol/core@2.0.0     protocol + types   (one dependency: zod)
@modelcontextprotocol/server@2.0.0   server runtime
```

Do not implement SSE; it is deprecated, and `@modelcontextprotocol/server-legacy` — which is only
the frozen v1 SSE transport — is therefore never needed.

## Why v2 rather than the v1 line

`@modelcontextprotocol/sdk` on npm is the **frozen v1 monolith**, which is why it still reads
`1.30.0` and supports only up to `2025-11-25`. v2 was published under split package names. Starting
on v1 would have meant a migration for no benefit.

Two consequences beyond currency:

- **`2026-07-28` removed the session handshake.** Every request carries its protocol version and the
  caller's capabilities in `_meta`, plus `Mcp-Method` (and `Mcp-Name`, where the payload names a
  target) in headers — and the server rejects any request whose headers and body disagree. That
  header/body consistency rule is what makes reading the method at the edge sound without consuming
  the body, which is how an unadvertised-tool attempt gets audited (see ADR-007).
- **The dependency surface shrank.** v1's `sdk` pulled ~17 runtime dependencies including express,
  cors, jose, and eventsource. v2's `core` has one. For a repository holding live refresh tokens
  that is a materially smaller attack surface.

Backward compatibility is already handled: `core@2.0.0` carries `2026-07-28`, `2025-11-25`, and
`2025-03-26`, so clients that have not upgraded still connect.

## Why stateless is mandatory rather than preferred

The M2 target replaces instances between requests. Any in-memory session state produces intermittent
404s under exactly the conditions that are hardest to reproduce. `createMcpHandler` builds a fresh
server instance per request from a factory, which is also what lets the tool list be a pure function
of the caller's resolved policy.

There is a memoised handler per principal, but what is memoised is the factory wiring, never session
state. The integration suite asserts this by restarting the endpoint mid-session and continuing to
serve the same caller.

## Caveat

v2.0.0 was 13 days old when adopted. It is the stable `latest`, not a prerelease, and it clears the
7-day `minimumReleaseAge` floor. v1 remains supported for at least six months, and the `packages/mcp`
boundary would keep a fallback cheap.
