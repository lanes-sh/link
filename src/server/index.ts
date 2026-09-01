import type { Authenticator } from '#auth';
import type { Logger } from '#connectivity';
import { capabilityIdForToolName } from '#server/mcp';
import { ATTACHMENTS_PATH, handleAttachments } from './attachments.ts';
import { allowedHostnamesFor, rebindingRefusal } from './rebinding.ts';
import { ANY_ORIGIN, corsAware, type CorsPolicy } from './cors.ts';
import { isReadPath, readRoutes, type ReadDeps } from './read/routes.ts';
import type { Generation } from './generation.ts';
import type { Generations } from './generations.ts';
import {
  authRefusal,
  failedAuthLimiter,
  unauthenticatedLimiter,
  unauthenticatedRefusal,
} from './edge.ts';
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
 * builds a fresh server instance per request from the generation's factory,
 * which is also what lets the tool list be a pure function of the caller's
 * policy.
 *
 * Authentication happens here, in front of that factory, so the factory only
 * ever runs for a caller whose identity is already established.
 *
 * What this file is *not* responsible for is which runtimes are current. A
 * request pins one generation on the way in and uses it throughout, so a reload
 * landing mid-request cannot change what that request is evaluated against.
 * See `./generations.ts`.
 */

export interface ServerOptions {
  /** The current profile runtimes, and the reload that replaces them. */
  readonly generations: Generations;
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
  /**
   * Meter the surface that answers before authentication.
   *
   * A property of what this is bound to, exactly as `cors` and
   * `allowedHostnames` are, and decided in the same lines of `serve()`. Off on
   * loopback, and that is not a gap: what the ceiling protects is a
   * credential-store call over the network and an object written to a bucket,
   * and on loopback both are a local file belonging to whoever is already
   * standing at the machine. `./rebinding.ts` refuses the one caller that is not
   * — a page the owner happens to be visiting — before this would be reached.
   */
  readonly meterUnauthenticated?: boolean | undefined;
  /**
   * The dashboard's read surface, when this bind may serve it (ADR-064).
   *
   * Another property of the bind address, decided in the same lines of
   * `serve()` as `cors` and the meter. Absent on loopback, where the TLS
   * listener in `./read/open.ts` serves it on its own port instead — a
   * cross-origin grant on `127.0.0.1` is what `./rebinding.ts` refuses
   * outright, and ADR-039's rule is not being relaxed to fit this in.
   */
  readonly read?: ReadDeps | undefined;
}

export const MCP_PATH = '/mcp';
export const RELOAD_PATH = '/reload';
/**
 * Named rather than inline, because two places now decide about it: the branch
 * that answers it, and the ceiling in front of that branch which has to know
 * that a `/health` carrying a credential is not the free request the other one
 * is.
 */
export const HEALTH_PATH = '/health';

/**
 * Loopback addresses. What binding to one changes is the browser threat model,
 * not the auth model — see `allowedHostnames`.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * How often an unrecognised tool name may provoke a reload.
 *
 * The safety net below reloads when a call names a tool this endpoint does not
 * advertise, which is what a just-connected provider looks like to an instance
 * that missed the notify. An agent retrying a genuinely absent tool must not
 * turn that into a reload per call, so it is bounded.
 */
const RELOAD_PROBE_MS = 10_000;

export interface RequestHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createRequestHandler(options: ServerOptions): RequestHandler {
  let probedAt = 0;
  const failedAuth = failedAuthLimiter();
  const unauthenticated = options.meterUnauthenticated ? unauthenticatedLimiter() : null;

  /**
   * Re-read the config because a call named a tool we do not serve.
   *
   * The notify (ADR-029) reaches one instance. A second instance that was warm
   * when the operator connected an account keeps refusing it, which would make
   * "connecting does not need a redeploy" true only sometimes — the worst of
   * the three possible states, because nobody can reproduce it.
   *
   * So the error path closes it. A tool that appeared a moment ago is
   * indistinguishable from a tool that never existed, and both arrive here; one
   * reload tells them apart. Nothing on the success path pays for this.
   */
  const probeForNewConfig = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - probedAt < RELOAD_PROBE_MS) return false;
    probedAt = now;

    const result = await options.generations.reload();
    return result.reloaded;
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

      // Ahead of every path that answers without a credential, because the
      // ceiling further down is inside the `401` branch and so has never covered
      // any of them. Each costs a read of the credential store or a write to the
      // workspace bucket, and none of them asks who is calling first. See
      // `./edge.ts` for which ones, and for why `/health` is only sometimes
      // among them.
      if (unauthenticated) {
        const refusal = unauthenticatedRefusal({
          request,
          pathname: url.pathname,
          limiter: unauthenticated,
          healthPath: HEALTH_PATH,
          isAuthorizationPath,
          authorizationEnabled: options.authorization !== undefined,
          isReadPath,
          readEnabled: options.read !== undefined,
        });
        if (refusal) {
          options.log.warn('rejected request', { reason: 'unauthenticated_rate' });
          return refusal;
        }
      }

      // Before authentication, deliberately: a client's first request is the
      // one that discovers how to authenticate, so requiring a token to read
      // the document that says where tokens come from would close the loop it
      // exists to open.
      if (options.authorization && isAuthorizationPath(url.pathname)) {
        return await handleAuthorization(request, options.authorization);
      }

      if (url.pathname === HEALTH_PATH) {
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
            ? { profile: options.primary, profiles: options.generations.current.names() }
            : {}),
        });
      }

      // Above the 404 gate because these are deliberately not in the three-path
      // set, and never through `options.authenticator`: the pairing token is a
      // different credential for a different surface, and one shared check
      // would make each able to do the other's job (ADR-063). Below the meter,
      // because verifying one costs a credential-store read. Only what
      // `isReadPath` matched is handed over — `readRoutes` answers everything
      // it is given, so a wider hand-off would swallow `/mcp`.
      if (options.read && isReadPath(url.pathname)) {
        return await readRoutes(request, options.read);
      }

      if (
        url.pathname !== MCP_PATH &&
        url.pathname !== ATTACHMENTS_PATH &&
        url.pathname !== RELOAD_PATH
      ) {
        return new Response('Not found', { status: 404 });
      }

      const outcome = await options.authenticator.authenticate(
        request.headers.get('authorization'),
      );

      // The refusal, and the ceiling on how often one may be provoked. Both in
      // `./edge.ts`, which is the subject: what this endpoint does about a
      // caller who has not authenticated.
      if (!outcome.ok) {
        options.log.warn('rejected request', { reason: outcome.reason });
        return authRefusal({
          request,
          reason: outcome.reason,
          limiter: failedAuth,
          metadataUrl: options.authorization ? resourceMetadataUrl(request) : null,
        });
      }

      // Behind the same bearer check as everything else, and deliberately not a
      // way to *change* configuration: it re-reads what the CLI already wrote to
      // the store this endpoint boots from, so the one-way flow ADR-004 requires
      // — local CLI to instance — is exactly what it follows. ADR-029.
      if (url.pathname === RELOAD_PATH) {
        const result = await options.generations.reload();
        return Response.json(result);
      }

      // A request works against one generation for its whole lifetime. Pinning
      // it here rather than reading `current` at each use is what makes a reload
      // landing mid-request invisible to this one: the config it is evaluated
      // against cannot change between two of its own awaits.
      let generation = options.generations.acquire();

      try {
        // Bytes in, handle out — the one thing a tool argument cannot carry,
        // since a file in a tool call is base64 in the model's output. It stages
        // into one named connection rather than a shared area, so a staged file
        // stays as isolated as the account it was staged for.
        if (url.pathname === ATTACHMENTS_PATH) {
          return await handleAttachments({
            profiles: generation.profiles,
            primary: options.primary,
            principal: outcome.principal,
            request,
            clientLabel: request.headers.get('x-mcp-client') ?? undefined,
          });
        }

        // After authentication, so an unauthenticated caller cannot make the
        // endpoint poll its store. Before `visible()`, because a skill added
        // since the last poll must not be audited as a refusal on its first call.
        await generation.refreshSkills();

        const clientLabel = request.headers.get('x-mcp-client') ?? undefined;

        // Policy-filtered discovery means an unpermitted tool is never
        // advertised, so a call naming one is rejected by the protocol layer
        // before dispatch — and would otherwise leave no trace. The 2026-07-28
        // envelope requires the method and target in headers and rejects any
        // request whose headers and body disagree, so reading them here is exact
        // without parsing (and consuming) the body.
        //
        // **Only for an envelope client.** A 2025-era request carries neither
        // header, and `createMcpHandler` is built without a `legacy` option —
        // whose default is `'stateless'`, so those requests are served rather
        // than refused. This check short-circuits and the refusal goes
        // unrecorded. That is the second documented exception to
        // `audit.every-invocation` in `https://lanes.sh/docs/link/security`, asserted in
        // `index.test.ts`. Closing it means cloning and parsing the body when
        // the header is absent, which is what `stdio.ts` does for want of
        // headers.
        //
        // `prompts/get` is included because a prompt is named exactly as a tool
        // is — `skills_review-diff` — so the same lookup is exact.
        // `resources/read` is **not**, and cannot be with this shape: 2026-07-28
        // mirrors `params.uri` rather than a name into the header, and a URI does
        // not match a wire name, so including it would record a refusal for every
        // successful read. Recovering a capability id from a concrete URI means
        // matching it against each registered template, which is a real design
        // decision — not least about what to record when it matches nothing —
        // and M4 did not take it. `resources.test.ts` asserts the gap.
        const method = request.headers.get('mcp-method');
        if (method === 'tools/call' || method === 'prompts/get') {
          const toolName = request.headers.get('mcp-name');

          if (toolName && !generation.visible().has(toolName)) {
            // Before recording it as a refusal: this instance may simply be
            // holding config older than the account the caller is naming.
            if (await probeForNewConfig()) {
              await options.generations.release(generation);
              generation = options.generations.acquire();
            }
          }

          if (toolName && !generation.visible().has(toolName)) {
            // Recorded against the primary profile: the body has not been read,
            // so which profile the call named is not yet known, and an attempt on
            // a tool no profile advertises belongs to none of them in particular.
            await generation.profiles.get(options.primary)!.dispatcher.recordRefusal({
              principal: outcome.principal,
              capabilityId: capabilityIdForToolName(toolName, generation.allCapabilityIds()),
              clientLabel,
            });
          }
        }

        return await generation.handlerFor(outcome.principal, clientLabel).fetch(request);
      } finally {
        await options.generations.release(generation);
      }
    },

    async close() {
      await options.generations.close();
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
  const current: Generation = options.generations.current;
  const primary = current.profiles.get(options.primary);
  if (!primary) throw new Error(`Profile "${options.primary}" is not among those being served.`);

  // Read once, from the generation that is current at bind time. A reload
  // cannot move a bound socket, so `instance.port` and `instance.host` are
  // deliberately not part of what reloading re-reads (ADR-029).
  const host = options.host ?? primary.config.instance.host;
  const port = options.port ?? primary.config.instance.port;

  const loopback = isLoopback(host);
  const allowedHostnames = options.allowedHostnames ?? allowedHostnamesFor(host, loopback);

  // Cross-origin access, and its absence, are decided here for the same reason
  // `allowedHostnames` is: both are properties of what this is bound to. The
  // two are mutually exclusive and the exclusion is the decision — see
  // `./cors.ts`, and ADR-039.
  const cors: CorsPolicy | undefined = loopback
    ? undefined
    : { allowedOrigins: primary.config.auth.allowed_origins ?? [ANY_ORIGIN] };
  // The fourth property of this bind address, decided with the other three.
  // Never on loopback: `./read/open.ts` serves it there over TLS on its own
  // port, and a deployment-only grant that leaked onto `127.0.0.1` is exactly
  // what ADR-039 refuses. Discarded rather than overridable, as `cors` is.
  const read = loopback ? undefined : options.read;

  const handler = createRequestHandler({
    ...options,
    ...(read ? { read } : { read: undefined }),
    // Off on loopback for the same reason `cors` is undefined there, and decided
    // here so every property of the bind address is decided together. An
    // explicit `true` wins, which is how a test drives the deployed behaviour.
    meterUnauthenticated: options.meterUnauthenticated ?? !loopback,
    ...(allowedHostnames ? { allowedHostnames } : {}),
  });

  const route = (request: Request): Promise<Response> => handler.fetch(request);
  const fetch = cors ? corsAware(route, [MCP_PATH, ATTACHMENTS_PATH], cors) : route;

  const server = Bun.serve({ hostname: host, port, fetch });

  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    async stop() {
      await handler.close();
      await server.stop(true);
    },
  };
}
