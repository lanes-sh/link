/**
 * Which agent is calling, read off the request rather than off a header.
 *
 * The audit log's `clientLabel` field has always said it holds "the MCP
 * `clientInfo` name". It did not. Over HTTP it read an `x-mcp-client` header,
 * which is not part of MCP and which no client sends; over a pipe nothing set
 * it at all. So the one field that exists to say *who made this call* was empty
 * on every event this endpoint has ever written.
 *
 * The protocol does carry it. A client announces itself at `initialize` and the
 * SDK repeats that announcement in every later request, in `_meta` under
 * `io.modelcontextprotocol/clientInfo`, which the server surfaces on the
 * request envelope. Reading it there rather than from the handshake is what
 * makes it work at all here: streamable HTTP is stateless on this endpoint, a
 * fresh `McpServer` is built and discarded per request (`build.ts`), and a
 * handshake captured on one instance is gone before the next arrives.
 *
 * **A client that announces itself only at `initialize` and never repeats it is
 * still anonymous**, and that is the honest outcome rather than a gap worth
 * papering over. The SDK does not backfill the envelope from the session, so
 * inferring one would mean this endpoint keeping its own session table to hold
 * a field it is not allowed to trust anyway.
 *
 * **Self-reported, and labelled as such wherever it surfaces.** A client may
 * call itself anything. It is recorded so a reader can see which agent made a
 * call and is never consulted to decide what that agent may do — the same rule
 * the field carried when it was a header, and the reason widening it is safe.
 */

/** Where the SDK puts the client's own `Implementation` on each request. */
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/**
 * The name the client gave for itself, or undefined.
 *
 * Deliberately tolerant. This is untrusted input on a path whose failure mode
 * would otherwise be an exception inside a tool call that was going to succeed,
 * and the worst honest outcome is the empty field that already exists.
 */
export function clientLabelFrom(extra: unknown): string | undefined {
  if (typeof extra !== 'object' || extra === null) return undefined;

  const request = (extra as { mcpReq?: unknown }).mcpReq;
  if (typeof request !== 'object' || request === null) return undefined;

  const envelope = (request as { envelope?: unknown }).envelope;
  if (typeof envelope !== 'object' || envelope === null) return undefined;

  const info = (envelope as Record<string, unknown>)[CLIENT_INFO_META_KEY];
  if (typeof info !== 'object' || info === null) return undefined;

  const name = (info as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}
