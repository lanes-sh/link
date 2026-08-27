import type { Authenticator } from '#auth';
import { dashboardPage, dashboardSignInPage, type DashboardConnection } from '#cli/dashboard-page.ts';
import type { Generations } from './generations.ts';

/**
 * The dashboard route.
 *
 * Local only, and mounted by nobody else: `lanes link start` asks for it and the
 * container entrypoint does not, with `serve()` refusing it a second time if the
 * bind address is not loopback. That is a decision rather than an omission, and
 * ADR-018 is why. Cloud Run IAM admits a caller holding a Google-signed identity
 * token; a browser doing a top-level navigation never sends one, so `access:
 * iam` answers a person with a 403 rather than a sign-in page. The mode a remote
 * client actually uses — `access: public` with an `auth.authorization` block —
 * leaves the front door open and gates `/mcp` on a bearer token instead, which a
 * navigation cannot carry either. Neither arrangement has a browser-shaped door,
 * so this one does not pretend to be reachable through them.
 *
 * What it serves is a reader. Nothing here writes config, authorises anything,
 * or reaches an upstream — see `#cli/dashboard-page.ts` for why that is the
 * honest shape rather than a limitation to lift later.
 */

export const DASHBOARD_PATH = '/dashboard';

/**
 * Whether a bind serves the dashboard.
 *
 * Two conditions, and both are load-bearing. Asking is the entrypoint's
 * decision — `lanes link start` does, the container does not. Loopback is the
 * one that does not depend on anybody remembering: a routable bind is a
 * deployed one, and the consequence of getting this wrong is a page listing the
 * owner's accounts on a public address. Named rather than inlined so the rule
 * can be stated once and asserted directly.
 */
export function servesDashboard(asked: boolean | undefined, loopback: boolean): boolean {
  return asked === true && loopback;
}

/** The query parameter `lanes link dashboard` puts the profile token in. */
const KEY_PARAM = 'k';

const COOKIE = 'lanes_link_dashboard';

/**
 * How long a browser stays signed in.
 *
 * Bounded rather than tied to the process: an endpoint left running for weeks
 * should not leave a tab that authenticated once able to read the workspace for
 * as long as it lives.
 */
const SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * Sessions this handler has issued.
 *
 * A random id, not the profile token. The token arrives once, in a URL the CLI
 * built, and is exchanged here for something that is worth nothing anywhere else
 * — so the credential that reaches every profile is never sitting in a cookie
 * jar, and revoking it is closing this process rather than clearing a browser.
 *
 * In memory, which is the one place stateless-by-design does not apply: this
 * route exists only on a single local process. The deployed instance that
 * `index.ts` keeps stateless for never serves it.
 */
export interface DashboardSessions {
  issue(): string;
  valid(id: string | null): boolean;
}

export function dashboardSessions(now: () => number = Date.now): DashboardSessions {
  const issued = new Map<string, number>();

  return {
    issue() {
      const id = crypto.randomUUID();
      const at = now();
      // Pruned on write rather than on a timer, so an endpoint nobody is
      // looking at holds nothing and runs nothing.
      for (const [key, expires] of issued) if (expires <= at) issued.delete(key);
      issued.set(id, at + SESSION_MS);
      return id;
    },
    valid(id) {
      if (!id) return false;
      const expires = issued.get(id);
      if (expires === undefined) return false;
      if (expires <= now()) {
        issued.delete(id);
        return false;
      }
      return true;
    },
  };
}

export interface DashboardSurface {
  readonly generations: Generations;
  readonly authenticator: Authenticator;
  /** The profile shown when the URL names none. */
  readonly primary: string;
  readonly sessions: DashboardSessions;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export async function handleDashboard(
  request: Request,
  surface: DashboardSurface,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get(KEY_PARAM);

  if (key !== null) {
    // The token is checked by the same authenticator every other route uses,
    // rather than compared here. One credential, one comparison, one place a
    // rotation has to land.
    const outcome = await surface.authenticator.authenticate(`Bearer ${key}`);
    if (!outcome.ok) return dashboardSignInPage(401);

    // Straight back out to a URL without it. A token that stays in the address
    // bar is one in the history, in the window title, and in whatever the next
    // link sends as a Referer — and this is the only request that needs it.
    url.searchParams.delete(KEY_PARAM);
    return new Response(null, {
      status: 303,
      headers: {
        location: `${url.pathname}${url.search}`,
        // No `Secure`: this is served over http on loopback and nowhere else,
        // and a Secure cookie would simply never be stored. `SameSite=Strict`
        // is what keeps another origin from navigating into an authenticated
        // view, and the rebinding check in front of every route (`index.ts`)
        // is what keeps one from being the origin in the first place.
        'set-cookie':
          `${COOKIE}=${surface.sessions.issue()}; HttpOnly; SameSite=Strict; ` +
          `Path=${DASHBOARD_PATH}; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
        'cache-control': 'no-store',
      },
    });
  }

  if (!surface.sessions.valid(cookieValue(request.headers.get('cookie'), COOKIE))) {
    return dashboardSignInPage(401);
  }

  // Pinned for the whole render, as a request on `/mcp` is: a reload landing
  // between the connection list and the provider catalogue would otherwise
  // produce a page describing two different configurations.
  const generation = surface.generations.acquire();
  try {
    const asked = url.searchParams.get('profile');
    const name = asked ?? surface.primary;
    const runtime = generation.profiles.get(name);

    // A name this endpoint does not serve can only have been typed: every
    // profile link on the page comes from the list below. Refusing beats
    // rendering a different profile than the URL says, which is the silent pick
    // `resolveSelection` exists to prevent.
    if (!runtime) return new Response('Not found', { status: 404 });

    const records = runtime.connections ? await runtime.connections() : [];
    const byKey = new Map(records.map((record) => [`${record.provider}.${record.id}`, record]));

    // The same join `lanes link status` makes: config says what should exist,
    // the store says what does, and the difference is the whole point of
    // showing it.
    const connections: DashboardConnection[] = runtime.config.connections.map((connection) => ({
      key: `${connection.provider}.${connection.id}`,
      provider: connection.provider,
      account: connection.account,
      ...(connection.label ? { label: connection.label } : {}),
      state: byKey.get(`${connection.provider}.${connection.id}`)?.status ?? 'not reconciled',
    }));

    // Never `instance.default_target`, which this line used to fall back to.
    // ADR-037 left that field inert precisely so a missing target surfaces here
    // rather than one command later: the page names a credential store, and a
    // page that guessed which one would report an account as connected against
    // a store the endpoint asking for it does not read.
    //
    // Absent only if a runtime reached this route without being opened against
    // anything, which a served endpoint never does — `endpoint.ts` builds every
    // entry in that map from a `Runtime`, whose target is required. Refusing
    // beats rendering, for the same reason the 404 above does.
    if (!runtime.target) return new Response('No target', { status: 500 });

    return dashboardPage({
      profile: name,
      profiles: generation.names(),
      target: runtime.target,
      // One, and it is the one being served. A revision serves exactly the
      // target it was deployed as, and the config no longer carries a list of
      // alternatives for it to offer (ADR-052).
      targets: [runtime.target],
      connections,
      ownClients: Object.keys(runtime.config.oauth_apps),
    });
  } finally {
    await surface.generations.release(generation);
  }
}
