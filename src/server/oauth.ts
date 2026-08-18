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
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
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
    return render(await server.register(await safeJson(request)), request);
  }

  if (path === AUTHORIZE_PATH) {
    if (request.method === 'GET') {
      return render(await server.authorize(url.searchParams), request);
    }
    if (request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      return render(await server.approve(requestFromForm(form), form.get('token') ?? ''), request);
    }
  }

  if (path === TOKEN_PATH && request.method === 'POST') {
    return render(await server.token(new URLSearchParams(await request.text())), request);
  }

  return new Response('Method not allowed', { status: 405 });
}

function render(result: OAuthResult, request: Request): Response {
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
        action: `${publicOrigin(request)}${AUTHORIZE_PATH}`,
        fields: formFromRequest(result.request),
        retry: result.retry,
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
