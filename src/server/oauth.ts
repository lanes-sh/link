import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  type AuthorizeRequest,
  type OAuthResult,
  type OAuthServer,
} from '#auth';
import { approvalPage } from '#cli/callback-page.ts';

/**
 * The HTTP surface of the authorization flow.
 *
 * Its own file so the router stays a router: `index.ts` gains a delegation, the
 * way it already delegates attachments, rather than six more branches and a
 * form parser. It also keeps that file inside its size budget, which is the
 * rule that would otherwise be relaxed to fit this in.
 *
 * Everything here is transport work — parse, dispatch, render. The decisions
 * live in `#auth`, which is what makes the flow testable as a sequence of
 * values rather than as a browser session.
 */

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';
const REGISTER_PATH = '/register';
const AUTHORIZE_PATH = '/authorize';
const TOKEN_PATH = '/token';

export interface AuthorizationSurface {
  /** Present only in `self` mode; `oidc` publishes metadata and issues nothing. */
  readonly server?: OAuthServer | undefined;
  /** Where a client should go to get a token — this origin, or an issuer's. */
  readonly issuer: (origin: string) => string;
  /** The MCP endpoint path, so `resource` names what the client actually calls. */
  readonly mcpPath: string;
  /**
   * The target this endpoint runs as, so the consent page can name the store its
   * token actually lives in. Credentials are per-target, and the reader is about
   * to run a command in a shell that resolves a target of its own — usually
   * `local`, which is the one store a deployed endpoint's token is never in.
   */
  readonly target: string;
}

/** Every path this surface answers, so the router can ask before authenticating. */
export function isAuthorizationPath(pathname: string): boolean {
  return (
    pathname === PROTECTED_RESOURCE_PATH ||
    pathname.startsWith(`${PROTECTED_RESOURCE_PATH}/`) ||
    pathname === AUTHORIZATION_SERVER_PATH ||
    pathname === REGISTER_PATH ||
    pathname === AUTHORIZE_PATH ||
    pathname === TOKEN_PATH
  );
}

/**
 * The origin a client used to reach here.
 *
 * Not `request.url`, and not config. Cloud Run terminates TLS and forwards the
 * original scheme in a header, so a URL built from the incoming request says
 * `http` and every metadata document would name a resource no client asked for
 * — which fails the exact-match the specification requires. Config cannot help
 * either: the hostname carries a project hash assigned at deploy time.
 *
 * **The host is `Host`, and `X-Forwarded-Host` is not consulted.** It used to
 * be, ahead of `Host`, and the justification above is entirely about the
 * *scheme* — nothing ever needed the other header. What it cost is that four
 * documents were steerable per request by whoever sent it: both discovery
 * documents, the `resource_metadata` pointer on every `401`, and the `action` of
 * the consent form that asks the owner to paste their endpoint token. Cloud Run
 * sets `Host` and routes on it, so it is the one value a caller cannot invent
 * without the request going somewhere else; a proxy that genuinely rewrites it
 * rewrites `Host` too, which is what a domain mapping does.
 *
 * The scheme is checked rather than trusted for the same reason, and it is a
 * smaller hole — naming `http` in a document downgrades nothing, it just makes
 * the exact-match fail — but a header that decides part of a URL should not
 * accept an arbitrary string.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;

  const forwarded = request.headers.get('x-forwarded-proto');
  const proto =
    forwarded === 'https' || forwarded === 'http' ? forwarded : url.protocol.replace(':', '');

  return `${proto}://${host}`;
}

export function resourceMetadataUrl(request: Request): string {
  return `${publicOrigin(request)}${PROTECTED_RESOURCE_PATH}`;
}

export async function handleAuthorization(
  request: Request,
  surface: AuthorizationSurface,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const path = url.pathname;

  // Both spellings: the bare document, and the one suffixed with the resource's
  // own path, which is what a client probes first when the `401` pointed it
  // nowhere. Answering both costs a comparison and removes a failure mode.
  if (path === PROTECTED_RESOURCE_PATH || path.startsWith(`${PROTECTED_RESOURCE_PATH}/`)) {
    return json(
      protectedResourceMetadata({
        resource: `${origin}${surface.mcpPath}`,
        issuer: surface.issuer(origin),
      }),
    );
  }

  if (path === AUTHORIZATION_SERVER_PATH) {
    // Only meaningful when this endpoint *is* the authorization server. Pointed
    // at an external issuer, the client reads that issuer's document instead,
    // and answering here with ours would send it to endpoints that do not exist.
    if (!surface.server) return new Response('Not found', { status: 404 });
    return json(authorizationServerMetadata(origin));
  }

  const server = surface.server;
  if (!server) return new Response('Not found', { status: 404 });

  if (path === REGISTER_PATH && request.method === 'POST') {
    return render(await server.register(await safeJson(request)), request, surface.target);
  }

  if (path === AUTHORIZE_PATH) {
    if (request.method === 'GET') {
      return render(await server.authorize(url.searchParams), request, surface.target);
    }
    if (request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      return render(
        await server.approve(requestFromForm(form), form.get('token') ?? ''),
        request,
        surface.target,
      );
    }
  }

  if (path === TOKEN_PATH && request.method === 'POST') {
    return render(
      await server.token(new URLSearchParams(await request.text())),
      request,
      surface.target,
    );
  }

  return new Response('Method not allowed', { status: 405 });
}

function render(result: OAuthResult, request: Request, target: string): Response {
  switch (result.kind) {
    case 'json':
      return json(result.body, result.status);

    case 'redirect':
      return new Response(null, { status: 302, headers: { location: result.location } });

    case 'consent':
      return approvalPage({
        // The name if it gave one, the identifier if not. Either way the
        // redirect host goes on the screen beside it — a client may call itself
        // anything, but it cannot change where the code is sent.
        client: result.clientName ?? result.request.clientId,
        redirectHost: hostOf(result.request.redirectUri),
        // The page's policy has to admit the redirect the page's own approval
        // ends in, or the browser blocks it. See `formActionFor`.
        ...formActionFor(result.request.redirectUri),
        action: `${publicOrigin(request)}${AUTHORIZE_PATH}`,
        fields: formFromRequest(result.request),
        retry: result.retry,
        target,
      });

    case 'error':
      return new Response(result.message, { status: result.status });
  }
}

/**
 * The authorization request, carried through the approval form.
 *
 * Round-tripped through hidden fields rather than held in a server-side session:
 * the deployed endpoint replaces instances between requests, so a session begun
 * on one and submitted to another would be gone. Nothing here is a secret — the
 * client sent all of it in the query string — and none of it is trusted on the
 * way back, because `approve` re-checks the client and the redirect URI against
 * what is registered before it mints anything.
 */
function formFromRequest(request: AuthorizeRequest): Record<string, string> {
  return {
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    scope: request.scope,
    ...(request.state !== undefined ? { state: request.state } : {}),
    ...(request.resource !== undefined ? { resource: request.resource } : {}),
  };
}

function requestFromForm(form: URLSearchParams): AuthorizeRequest {
  return {
    clientId: form.get('client_id') ?? '',
    redirectUri: form.get('redirect_uri') ?? '',
    codeChallenge: form.get('code_challenge') ?? '',
    scope: form.get('scope') ?? '',
    state: form.get('state') ?? undefined,
    resource: form.get('resource') ?? undefined,
  };
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/**
 * The redirect target as a CSP source, for the consent page's `form-action`.
 *
 * Chrome and Safari check that directive against the redirect a form submission
 * produces, so the page has to name where its own approval is about to send the
 * browser — `'self'` alone mints the code and then blocks its delivery.
 *
 * Taken from the request being approved rather than from what the client
 * registered, because the two legitimately differ: a native client registers
 * `http://localhost/callback` and binds whatever port it got (RFC 8252), and
 * the origin the browser navigates to is the one carrying that port. It is
 * already checked against the registration — by `authorize` before this page is
 * rendered, and again by `approve` before anything is minted — and it cannot
 * move the token, because the form's `action` is built here rather than read
 * from the request.
 *
 * An origin and nothing else, because `isSafeRedirect` registers nothing else:
 * https, or http on loopback. A private-use scheme — `vscode:`, the other shape
 * RFC 8252 allows — would need a scheme-source here, and is refused two steps
 * earlier, so a branch for it would be a branch nothing can reach.
 */
function formActionFor(uri: string): { formAction?: string } {
  try {
    const { protocol, origin } = new URL(uri);
    if (protocol !== 'http:' && protocol !== 'https:') return {};
    return { formAction: origin };
  } catch {
    return {};
  }
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Discovery documents are public by definition and read on every fresh
      // connection; `no-store` on the token endpoint is the part that matters,
      // and it is the default for a POST anyway.
      'cache-control': 'no-store',
    },
  });
}
