import {
  createMcpHandler,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { challenge, ownerPrincipal, type Authenticator, type Principal } from '#auth';
import type { Logger } from '#connectivity';
import {
  buildMcpServer,
  capabilityIdForToolName,
  toolNameFor,
  visibleCapabilities,
  type ProfileRuntime,
} from '#server/mcp';
import { ATTACHMENTS_PATH, stageAttachment } from './attachments.ts';
import { allowedHostnamesFor, rebindingRefusal } from './rebinding.ts';
import {
  handleAuthorization,
  isAuthorizationPath,
  resourceMetadataUrl,
  type AuthorizationSurface,
} from './oauth.ts';

/**
 * The HTTP surface.
 *
 * Stateless streamable HTTP on a single endpoint. Statelessness is not an
 * optimisation: the M2 target replaces instances between requests, so any
 * in-memory session state would produce intermittent 404s. `createMcpHandler`
 * builds a fresh server instance per request from the factory below, which is
 * also what lets the tool list be a pure function of the caller's policy.
 *
 * Authentication happens here, in front of the factory, so the factory only
 * ever runs for a caller whose identity is already established.
 */

export interface ServerOptions {
  /** Every profile this endpoint serves, keyed by name. */
  readonly profiles: ReadonlyMap<string, ProfileRuntime>;
  /** Which profile's port, host, and token govern the endpoint itself. */
  readonly primary: string;
  readonly authenticator: Authenticator;
  readonly log: Logger;
  readonly version?: string;
  /**
   * How a remote client obtains a token, when the profile declares one.
   *
   * Absent means bearer-token-only: no metadata is published, the `401` carries
   * no pointer, and the endpoint behaves exactly as it did before.
   */
  readonly authorization?: AuthorizationSurface | undefined;
  /** Hostnames this endpoint answers to. See `./rebinding.ts`. */
  readonly allowedHostnames?: readonly string[] | undefined;
}

export const MCP_PATH = '/mcp';

/**
 * Loopback addresses. What binding to one changes is the browser threat model,
 * not the auth model — see `allowedHostnames`.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export interface RequestHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createRequestHandler(options: ServerOptions): RequestHandler {
  const handlers = new Map<string, McpHttpHandler>();

  /**
   * How stale a registry may be before the next request re-reads its skills.
   *
   * A skill written elsewhere — `lanes link skills add` in another terminal — cannot
   * announce itself, so the endpoint has to look. Bounded rather than
   * per-request because looking costs a `list()`, which on S3 is a network
   * call: at most one per profile per interval, however busy the endpoint is.
   * A write made *through* MCP does not wait for this; it refreshes directly.
   */
  const SKILL_POLL_MS = 2_000;
  let polledAt = 0;

  const refreshSkills = async (): Promise<void> => {
    const now = Date.now();
    if (now - polledAt < SKILL_POLL_MS) return;
    polledAt = now;

    await Promise.all(
      [...options.profiles.values()].map(async (runtime) => {
        try {
          await runtime.refreshSkills?.();
        } catch (error) {
          // A skills directory that has gone unreadable, or one skill file
          // someone is mid-edit, must not take the endpoint down with it. The
          // previously loaded skills stay registered.
          options.log.warn('could not refresh skills', { message: (error as Error).message });
        }
      }),
    );
  };

  /**
   * Work derived from the registries, recomputed when one of them changes.
   *
   * These were memoised once, which was correct while a registry was fixed for
   * the life of the process. Skills can now be replaced in it (ADR-014), and a
   * stale `visible()` is not a cosmetic problem: it gates the refusal-audit
   * path below, so a newly added skill would be recorded as a refusal on its
   * first `prompts/get` even though the call succeeded.
   */
  const generation = (): number =>
    [...options.profiles.values()].reduce((total, runtime) => total + runtime.registry.revision, 0);

  const memoise = <T>(compute: () => T): (() => T) => {
    let at = -1;
    let value: T;
    return () => {
      const now = generation();
      if (now !== at) {
        value = compute();
        at = now;
      }
      return value;
    };
  };

  /**
   * Every capability id across every profile, granted or not.
   *
   * Used only to spell a refusal correctly: a tool that exists but is not
   * permitted should appear in the audit under its real id.
   */
  const allCapabilityIds = memoise(() => [
    ...new Set(
      [...options.profiles.values()].flatMap((runtime) =>
        runtime.registry.capabilities().map(({ id }) => id),
      ),
    ),
  ]);

  /**
   * Wire names the endpoint advertises.
   *
   * M1 has a single principal per profile, so this set does not vary by
   * caller. When delegated principals arrive it becomes a per-principal
   * lookup; the call site already reads as one.
   */
  const visible = memoise(
    () =>
      new Set(
        visibleCapabilities({
          profiles: options.profiles,
          principal: ownerPrincipal(options.primary),
        }).map(toolNameFor),
      ),
  );

  /**
   * One handler per (principal, client label), memoised.
   *
   * The MCP surface depends only on resolved policy, so rebuilding the wiring
   * per request would be pure waste. Reuse is safe because `createMcpHandler`
   * still constructs a fresh server instance per request — what is memoised is
   * the factory wiring, never session state.
   */
  const handlerFor = (principal: Principal, clientLabel: string | undefined): McpHttpHandler => {
    const key = `${principal.id}\u0000${clientLabel ?? ''}`;
    const existing = handlers.get(key);
    if (existing) return existing;

    const handler = createMcpHandler(
      // The principal is closed over rather than read back out of `authInfo`:
      // this handler is already keyed on it, and re-deriving identity from a
      // field the SDK treats as opaque pass-through would create a second
      // source of truth for who is calling.
      (_context: McpRequestContext) =>
        buildMcpServer({
          profiles: options.profiles,
          principal,
          clientLabel,
          ...(options.version ? { version: options.version } : {}),
        }),
      {
        onerror: (error: Error) =>
          options.log.error('mcp handler error', { message: error.message }),
      },
    );

    handlers.set(key, handler);
    return handler;
  };

  return {
    async fetch(request) {
      // Ahead of everything, including the pre-auth discovery routes: those are
      // exactly what a rebound origin reaches.
      if (options.allowedHostnames) {
        const refusal = rebindingRefusal(request, options.allowedHostnames);
        if (refusal) return refusal;
      }

      const url = new URL(request.url);

      // Before authentication, deliberately: a client's first request is the
      // one that discovers how to authenticate, so requiring a token to read
      // the document that says where tokens come from would close the loop it
      // exists to open.
      if (options.authorization && isAuthorizationPath(url.pathname)) {
        return await handleAuthorization(request, options.authorization);
      }

      if (url.pathname === '/health') {
        // `status` is unauthenticated because the platform's own probe reads it
        // and a deploy waits on it. The profile *names* are not: on a public URL
        // that is a list of what this endpoint holds, handed to anyone who asks,
        // and `outputs` and `mcp add` — which are the reason it was ever
        // published — both hold the token already.
        const named = await options.authenticator.authenticate(
          request.headers.get('authorization'),
        );

        return Response.json({
          status: 'ok',
          ...(named.ok
            ? { profile: options.primary, profiles: [...options.profiles.keys()] }
            : {}),
        });
      }

      if (url.pathname !== MCP_PATH && url.pathname !== ATTACHMENTS_PATH) {
        return new Response('Not found', { status: 404 });
      }

      const outcome = await options.authenticator.authenticate(
        request.headers.get('authorization'),
      );

      if (!outcome.ok) {
        options.log.warn('rejected request', { reason: outcome.reason });

        // The pointer is the whole handshake for a remote client: it reads the
        // named document, finds the authorization server, and starts a flow.
        // Without it the client has to guess the document's location, and a
        // client that guesses wrong reports the endpoint as unreachable.
        const metadata = options.authorization ? resourceMetadataUrl(request) : null;

        return new Response(
          JSON.stringify({
            error: 'unauthorized',
            reason: outcome.reason,
            hint:
              outcome.reason === 'not_configured'
                ? 'This profile has no token yet. Run: lanes link token rotate'
                : 'Present the profile token as: Authorization: Bearer <token>',
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': challenge(metadata),
            },
          },
        );
      }

      // Bytes in, handle out — the one thing a tool argument cannot carry, since
      // a file in a tool call is base64 in the model's output. Behind the same
      // bearer check as everything else, and it stages into one named connection
      // rather than a shared area, so a staged file stays as isolated as the
      // account it was staged for.
      if (url.pathname === ATTACHMENTS_PATH) {
        return await stageAttachment({
          profiles: options.profiles,
          primary: options.primary,
          principal: outcome.principal,
          request,
          clientLabel: request.headers.get('x-mcp-client') ?? undefined,
        });
      }

      // After authentication, so an unauthenticated caller cannot make the
      // endpoint poll its store. Before `visible()`, because a skill added
      // since the last poll must not be audited as a refusal on its first call.
      await refreshSkills();

      const clientLabel = request.headers.get('x-mcp-client') ?? undefined;

      // Policy-filtered discovery means an unpermitted tool is never
      // advertised, so a call naming one is rejected by the protocol layer
      // before dispatch — and would otherwise leave no trace. The 2026-07-28
      // envelope requires the method and target in headers and rejects any
      // request whose headers and body disagree, so reading them here is exact
      // without parsing (and consuming) the body.
      //
      // **Only for an envelope client.** A 2025-era request carries neither
      // header, and `createMcpHandler` above is built without a `legacy`
      // option — whose default is `'stateless'`, so those requests are served
      // rather than refused. This check short-circuits and the refusal goes
      // unrecorded. That is the second documented exception to
      // `audit.every-invocation` in `docs/detailed/security.md`, asserted in
      // `index.test.ts`. Closing it means cloning and parsing the body when the
      // header is absent, which is what `stdio.ts` does for want of headers.
      //
      // `prompts/get` is included because a prompt is named exactly as a tool
      // is — `skills_review-diff` — so the same lookup is exact. `resources/read`
      // is **not**, and cannot be with this shape: 2026-07-28 mirrors
      // `params.uri` rather than a name into the header, and a URI does not
      // match a wire name, so including it would record a refusal for every
      // successful read. Recovering a capability id from a concrete URI means
      // matching it against each registered template, which is a real design
      // decision — not least about what to record when it matches nothing —
      // and M4 did not take it. `resources.test.ts` asserts the gap.
      const method = request.headers.get('mcp-method');
      if (method === 'tools/call' || method === 'prompts/get') {
        const toolName = request.headers.get('mcp-name');
        if (toolName && !visible().has(toolName)) {
          // Recorded against the primary profile: the body has not been read,
          // so which profile the call named is not yet known, and an attempt on
          // a tool no profile advertises belongs to none of them in particular.
          await options.profiles.get(options.primary)!.dispatcher.recordRefusal({
            principal: outcome.principal,
            capabilityId: capabilityIdForToolName(toolName, allCapabilityIds()),
            clientLabel,
          });
        }
      }

      return handlerFor(outcome.principal, clientLabel).fetch(request);
    },

    async close() {
      await Promise.all([...handlers.values()].map((handler) => handler.close()));
      handlers.clear();
    },
  };
}

export interface ServeOptions extends ServerOptions {
  readonly port?: number;
  readonly host?: string;
}

export interface RunningServer {
  readonly url: string;
  stop(): Promise<void>;
}

export function serve(options: ServeOptions): RunningServer {
  const primary = options.profiles.get(options.primary);
  if (!primary) throw new Error(`Profile "${options.primary}" is not among those being served.`);

  const host = options.host ?? primary.config.instance.host;
  const port = options.port ?? primary.config.instance.port;

  const allowedHostnames = options.allowedHostnames ?? allowedHostnamesFor(host, isLoopback(host));
  const handler = createRequestHandler({
    ...options,
    ...(allowedHostnames ? { allowedHostnames } : {}),
  });

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (request: Request) => handler.fetch(request),
  });

  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    async stop() {
      await handler.close();
      await server.stop(true);
    },
  };
}
