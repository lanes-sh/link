import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { ownerPrincipal } from '#auth';
import type { Logger } from '#connectivity';
import {
  buildMcpServer,
  capabilityIdForToolName,
  toolNameFor,
  visibleCapabilities,
  type ProfileRuntime,
} from './mcp/index.ts';

/**
 * The stdio surface.
 *
 * Same registry, same policy, same audit as the HTTP endpoint — a different
 * boundary. Over HTTP a caller proves who they are with a bearer token, because
 * anyone who can reach the port might be anyone. Over stdio the pipe *is* the
 * proof: this process was spawned by the client holding the other end of it, as
 * the operator, with no port for anyone else to reach. There is nothing left to
 * authenticate, so this path has no authenticator and no token — it serves the
 * owner principal directly.
 *
 * It exists because a client can be unable to speak HTTP at all. Claude
 * Desktop's `claude_desktop_config.json` validates each entry against
 * `{ command, args?, env?, extensionId? }` — a `url` is not a field it has, so
 * "point it at the endpoint" is not available and something must speak MCP on
 * its stdin and stdout.
 *
 * Two differences from HTTP are worth knowing, and neither is incidental:
 *
 * - **The tool list is fixed for the connection.** `createMcpHandler` builds a
 *   fresh server per request, so an HTTP caller sees a skill added a moment ago.
 *   `serveStdio` pins one instance for the life of the pipe (the era decision is
 *   made once, at the opening exchange), so a skill added mid-session appears on
 *   the next launch. A client that spawns this per session — which is how they
 *   all work — gets the current list every time it starts.
 * - **One connection, one process.** The client owns the lifetime: it spawns the
 *   process, and closing the pipe ends it.
 */

export interface StdioOptions {
  /** Every profile this surface serves, keyed by name. */
  readonly profiles: ReadonlyMap<string, ProfileRuntime>;
  /** Which profile owns the connection — the one a call defaults to naming. */
  readonly primary: string;
  readonly log: Logger;
  readonly version?: string | undefined;
  readonly clientLabel?: string | undefined;
  /**
   * Bring your own transport, rather than this process's stdin and stdout.
   *
   * A test drives the real surface over a pair of in-memory streams with it. It
   * is the same seam the SDK offers for serving stdio over a socket.
   */
  readonly transport?: Transport | undefined;
}

export interface StdioSurface {
  /** Tears down the connection and the server instance pinned to it. */
  close(): Promise<void>;
}

export function serveOverStdio(options: StdioOptions): StdioSurface {
  if (!options.profiles.has(options.primary)) {
    throw new Error(`Profile "${options.primary}" is not among those being served.`);
  }

  const principal = ownerPrincipal(options.primary);

  /**
   * Wire names this principal may see, and every capability id behind them.
   *
   * Computed once because the pinned instance's tool list is fixed for the
   * connection anyway — the memoisation the HTTP path needs exists only because
   * it rebuilds per request.
   */
  const visible = new Set(
    visibleCapabilities({ profiles: options.profiles, principal }).map(toolNameFor),
  );
  const allCapabilityIds = [
    ...new Set(
      [...options.profiles.values()].flatMap((runtime) =>
        runtime.registry.capabilities().map(({ id }) => id),
      ),
    ),
  ];

  const handle = serveStdio(
    () =>
      buildMcpServer({
        profiles: options.profiles,
        principal,
        ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
        ...(options.version ? { version: options.version } : {}),
      }),
    {
      transport: auditRefusals(options.transport ?? new StdioServerTransport(), (message) =>
        recordRefusal(message, options, visible, allCapabilityIds),
      ),
      onerror: (error: Error) => options.log.error('mcp stdio error', { message: error.message }),
    },
  );

  return { close: () => handle.close() };
}

/**
 * A call naming a tool policy filtering hid, recorded as a refusal.
 *
 * The same trace the HTTP edge writes, from the only place this transport can
 * write it. Policy-filtered discovery means an unpermitted tool is never
 * advertised, so the protocol layer answers a call naming one before any of our
 * code runs — and it would otherwise leave no trace at all, which is what
 * `audit.every-invocation` in `docs/detailed/security.md` promises it does not.
 *
 * HTTP reads the method and target from the 2026-07-28 headers, which is exact
 * for an envelope client and blind to a 2025-era one — a documented gap over
 * there, and not one here. There are no headers on a pipe, so this reads the
 * body unconditionally, which is cheap because the transport has already parsed
 * it into a message.
 */
function recordRefusal(
  message: JSONRPCMessage,
  options: StdioOptions,
  visible: ReadonlySet<string>,
  allCapabilityIds: readonly string[],
): void {
  if (!('method' in message) || !('id' in message)) return;
  if (message.method !== 'tools/call' && message.method !== 'prompts/get') return;

  const params = (message as { params?: { name?: unknown } }).params;
  const toolName = typeof params?.name === 'string' ? params.name : undefined;
  if (!toolName || visible.has(toolName)) return;

  // Not awaited: `onmessage` is synchronous, and holding the message back to
  // wait on a store would delay the refusal the caller is owed. The row lands
  // just after the error does.
  //
  // `resources/read` is absent for the same reason it is absent over HTTP: a
  // concrete URI does not match a wire name, so recovering the capability id
  // means matching it against every registered template. `resources.test.ts`
  // asserts that gap rather than hiding it.
  void options.profiles
    .get(options.primary)!
    .dispatcher.recordRefusal({
      principal: ownerPrincipal(options.primary),
      capabilityId: capabilityIdForToolName(toolName, allCapabilityIds),
      ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
    })
    .catch((error: Error) =>
      options.log.warn('could not record refusal', { message: error.message }),
    );
}

/**
 * The transport, with a look at every inbound message on its way past.
 *
 * A wrapper rather than a subclass because the SDK owns the transport it is
 * handed: it installs its own `onmessage`, starts it, and closes it. Assigning
 * the inner transport's callbacks here and forwarding them keeps that ownership
 * intact — the entry sees exactly what the pipe delivered, in the same order.
 */
function auditRefusals(inner: Transport, inspect: (message: JSONRPCMessage) => void): Transport {
  const outer: Transport = {
    start: () => inner.start(),
    send: (message, sendOptions) => inner.send(message, sendOptions),
    close: () => inner.close(),
    ...(inner.setProtocolVersion
      ? { setProtocolVersion: (version: string) => inner.setProtocolVersion!(version) }
      : {}),
    ...(inner.setSupportedProtocolVersions
      ? {
          setSupportedProtocolVersions: (versions: string[]) =>
            inner.setSupportedProtocolVersions!(versions),
        }
      : {}),
  };

  inner.onmessage = (message, extra) => {
    try {
      inspect(message);
    } catch {
      // An audit attempt must never cost the caller their message.
    }
    outer.onmessage?.(message, extra);
  };
  inner.onclose = () => outer.onclose?.();
  inner.onerror = (error) => outer.onerror?.(error);

  return outer;
}
