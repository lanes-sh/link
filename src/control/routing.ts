import type { ControlAssertion } from './assertion.ts';
import type { Requirement } from './authorise.ts';
import type { WorkspaceReaders, WorkspaceWriters } from './commands.ts';

/**
 * The vocabulary a control route is written in.
 *
 * Its own file so the two route tables and the pipeline can all import it
 * without importing each other — `routes.ts` assembles the tables and the
 * tables need `Route`, which is a cycle unless the shape lives somewhere both
 * can reach.
 *
 * Everything here is the same in every route: what a route *is*, how it
 * answers, what a valid name looks like, and the one gate every mutation on an
 * existing profile shares.
 */

/**
 * Whether the router should hand this path over.
 *
 * A predicate rather than an exported array, so the router owns no literal of
 * its own and cannot come to disagree with the handler about which paths these
 * are. `isReadPath` and `isAuthorizationPath` are the same shape for the same
 * reason — and the hand-off must stay narrow, because this answers everything
 * it is given and a wider one would swallow `/mcp`.
 */
/**
 * The prefix this surface claims. Everything else is the endpoint's.
 *
 * A prefix rather than a list of literals, because most of these paths carry
 * parameters — `/v1/profiles/:profile/grants/:connection` and four more — and a
 * literal list silently stops claiming them. That failure has no symptom in a
 * route's own test: each one passes against `controlRoutes` directly while the
 * router never hands any of them over, so the whole surface is unreachable in
 * production and green in CI.
 *
 * Safe as a prefix because nothing the endpoint serves begins with it: `/mcp`,
 * `/health`, `/reload`, `/state`, `/audit`, `/attachments` and the OAuth paths
 * are all outside `/v1/`. The hand-off must stay this narrow — `controlRoutes`
 * answers everything it is given, so a wider one would swallow `/mcp`.
 */
const CLAIMED = '/v1/';

export function isControlPath(pathname: string): boolean {
  return pathname.startsWith(CLAIMED);
}

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** One answer for a path that does not exist and for a workspace that is not this one. */
export const notFound = (): Response => json({ error: 'not_found' }, 404);

/**
 * What the config format accepts as a profile name.
 *
 * The same shape as `identifier` in `#profile/schema.ts`. Restated rather than
 * imported because this refuses *before* anything is written, and the schema's
 * copy refuses after — one is a 400 with a sentence and the other is a parse
 * failure three frames down.
 */
export const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;

/** `<provider>.<id>`, the shape `connectionRefOf` produces. */
export const CONNECTION_REF = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_-]*$/;

/** A capability id, or a trailing `.*` — the only operator policy allows. */
export const CAPABILITY = /^[a-z][a-z0-9_]*(\.[a-z0-9_*]+)*$/;

/** `lanes:<uid>` and nothing else — the spelling a profile's `members:` uses. */
export const SUBJECT = /^lanes:[A-Za-z0-9_-]+$/;

/**
 * The third gate, for every route that changes an existing profile.
 *
 * One function rather than the check repeated per route: five routes asking the
 * same question five times is five chances for one of them to forget, and this
 * is the component where forgetting is somebody else's mailbox.
 *
 * Returns the refusal, or null to proceed. Read before any write.
 */
export async function profileOpenToAgents(
  profile: string,
  writers: WorkspaceWriters,
  env: Record<string, string | undefined>,
): Promise<Response | null> {
  if (await writers.agentMayManage(profile, env)) return null;
  return json(
    {
      error:
        `The profile "${profile}" is not open to being changed by an agent. Its ` +
        '`agent_management` is set to deny; a person can still change it from the dashboard ' +
        'or the CLI.',
    },
    403,
  );
}

export interface RouteContext {
  readonly assertion: ControlAssertion;
  /** Path segments a parameterised route captured. */
  readonly params: Record<string, string>;
  readonly root: string;
  readonly readers: WorkspaceReaders;
  readonly writers: WorkspaceWriters;
  /** The environment a command runs in: this workspace's root, and nothing ambient. */
  readonly env: Record<string, string | undefined>;
  readonly body: () => Promise<unknown>;
}

export interface Route {
  readonly method: string;
  /** A literal path, or one carrying `:name` segments. */
  readonly path: string;
  readonly needs: Requirement;
  run(context: RouteContext): Promise<Response>;
}
