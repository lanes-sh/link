import type { Logger } from '#connectivity';
import {
  liveReaders,
  liveWriters,
  type ProfilesResult,
  type WorkspaceReaders,
  type WorkspaceWriters,
} from './commands.ts';
import { environmentFor, MANAGED_TARGET } from './workspace.ts';
import { loadWorkspaceProfiles } from '#profile';
import { READS, WIDENS, permits, workspaceRootFor } from './authorise.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * The control plane's HTTP surface, mounted in the runtime's own router.
 *
 * Every route here reaches configuration for exactly one workspace, and which
 * one is decided by a signed statement rather than by anything the caller
 * wrote. `workspaceRootFor` takes the verified assertion and nothing else, and
 * no route reads a workspace from a path, a query or a body. A caller may name
 * one; it changes nothing, and a test says so.
 *
 * ## Why this is inside the endpoint rather than beside it
 *
 * It was a separate service, on the reasoning that a managed endpoint has to be
 * publicly reachable — no MCP client can mint a Google identity token, so Cloud
 * Run IAM cannot admit one (ADR-018) — and that a control plane therefore
 * needed its own IAM-locked process.
 *
 * Every clause of that is true and the conclusion does not follow. It holds
 * only if a client connects *to this endpoint*, and it does not: `api.lanes.sh`
 * is the single public surface, and a managed runtime is
 * `--no-allow-unauthenticated`. So IAM is already the outer gate here, and a
 * second process bought nothing that this file does not have.
 *
 * ADR-064 is the shape, not an improvisation: `/state` and `/audit` are mounted
 * the same way, with their own credential, never passing through
 * `options.authenticator`, and only what a path predicate matched handed over.
 *
 * ## What ADR-007 still guarantees, and what it does not
 *
 * Its letter changes: this revision *can* write its own configuration. Its
 * purpose does not. An agent reaching `/mcp` holds an MCP token and cannot
 * forge an assertion `api.lanes.sh` signed, so it still cannot widen its own
 * access — which is the whole of what that decision protects. A **self-hosted**
 * endpoint mounts none of this and is unchanged.
 *
 * ## The property the merge made stronger
 *
 * The router resolved a workspace before this runs, and the assertion names
 * one. Two independent statements of which tenant this is, from different
 * sources, and a mismatch is refused. The separate service had only the
 * assertion.
 */

export interface ControlDeps {
  /**
   * The workspace this runtime's router resolved for the request.
   *
   * Checked against the assertion rather than trusted: agreement is the second
   * statement, and a valid assertion for one workspace arriving at another's
   * runtime is refused.
   */
  readonly workspace: string;
  readonly verifier: { verify(token: string): Promise<ControlAssertion | null> };
  readonly log: Logger;
  readonly readers?: WorkspaceReaders;
  readonly writers?: WorkspaceWriters;
  /** Test seams, so a route test needs no workspace on disk. */
  readonly create?: WorkspaceWriters['create'];
  readonly grant?: WorkspaceWriters['grant'];
  readonly agentMayManage?: WorkspaceWriters['agentMayManage'];
}

/**
 * What the config format accepts as a profile name.
 *
 * The same shape as `identifier` in `#profile/schema.ts`. Restated rather than
 * imported because this refuses *before* anything is written, and the schema's
 * copy refuses after — one is a 400 with a sentence and the other is a parse
 * failure three frames down.
 */
const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;

/** `<provider>.<id>`, the shape `connectionRefOf` produces. */
const CONNECTION_REF = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_-]*$/;

/** The paths this surface claims. Everything else is the endpoint's. */
const PATHS: readonly string[] = ['/v1/profiles', '/v1/connections'];

/**
 * Whether the router should hand this path over.
 *
 * A predicate rather than an exported array, so the router owns no literal of
 * its own and cannot come to disagree with the handler about which paths these
 * are. `isReadPath` and `isAuthorizationPath` are the same shape for the same
 * reason — and the hand-off must stay narrow, because this answers everything
 * it is given and a wider one would swallow `/mcp`.
 */
export function isControlPath(pathname: string): boolean {
  return PATHS.includes(pathname);
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** One answer for a path that does not exist and for a workspace that is not this one. */
const notFound = (): Response => json({ error: 'not_found' }, 404);

/**
 * Answer one control request.
 *
 * A plain function rather than a factory holding state: the router already
 * decided which workspace this is and hands it in, so there is nothing to
 * construct and nothing to keep between calls.
 */
export async function controlRoutes(request: Request, deps: ControlDeps): Promise<Response> {
  const readers = deps.readers ?? liveReaders;
  const writers: WorkspaceWriters = {
    ...(deps.writers ?? liveWriters),
    ...(deps.create ? { create: deps.create } : {}),
    ...(deps.grant ? { grant: deps.grant } : {}),
    ...(deps.agentMayManage ? { agentMayManage: deps.agentMayManage } : {}),
  };
  const url = new URL(request.url);

  // Unknown paths are refused before the credential is looked at. A caller
  // probing for routes should not be able to tell a path that exists from one
  // that does not by which of them costs a signature verification.
  const matched = match(request.method, url.pathname);
  if (!matched) return notFound();
  const { route, params } = matched;

  const header = request.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return json({ error: 'unauthenticated' }, 401);
  }

  const assertion = await deps.verifier.verify(token);
  if (assertion === null) {
    // One answer for every way a statement can fail to convince, for the reason
    // the verifier returns null rather than a reason: a caller told which check
    // failed learns which attempt got closer.
    deps.log.warn('rejected a control assertion', { path: url.pathname });
    return json({ error: 'unauthenticated' }, 401);
  }

  // The second statement of which tenant this is. The router resolved one from
  // the request and the assertion names one; both are believed only where they
  // agree. Refused as an unknown path rather than as a mismatch, because which
  // of the two failed is the log's business and not the caller's.
  if (assertion.workspace !== deps.workspace) {
    deps.log.warn('a control assertion named another workspace', {
      resolved: deps.workspace,
      asserted: assertion.workspace,
    });
    return notFound();
  }

  const refusal = permits(assertion, route.needs);
  if (refusal) return json({ error: refusal.message }, refusal.status);

  // From the assertion, never from the router: the signed statement is what
  // authorises this call, and a routing artefact is not.
  const root = workspaceRootFor(assertion);

  try {
    return await route.run({
      assertion,
      root,
      readers,
      writers,
      params,
      // From the assertion, exactly as `root` is. A command reads its workspace
      // out of this rather than out of `process.env`, which one process serving
      // many workspaces cannot use.
      env: environmentFor(assertion),
      body: () => request.json(),
    });
  } catch (error) {
    // The workspace, not the caller: a bucket that would not answer, a profile
    // mid-write. Reported without its message, which can carry a path or a
    // bucket name the caller has no business learning.
    deps.log.error('a control route failed', {
      path: url.pathname,
      workspace: assertion.workspace,
      message: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'unavailable' }, 503);
  }
}

interface RouteContext {
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

interface Route {
  readonly method: string;
  /** A literal path, or one carrying `:name` segments. */
  readonly path: string;
  readonly needs: typeof READS | typeof WIDENS;
  run(context: RouteContext): Promise<Response>;
}

/**
 * The table, so what a route costs is declared beside what it does.
 *
 * `needs` is on the row rather than inside the handler deliberately: a
 * permission check written in a body is one a new route can be added without,
 * and this component is the one place where forgetting that is somebody else's
 * mailbox.
 */
/**
 * Which route answers this request, and what its path captured.
 *
 * Hand-written rather than a router dependency: there are four routes, the
 * shapes are `/a/b` and `/a/:x/b/:y`, and a matcher is fifteen lines against a
 * dependency this repository would have to justify holding while it holds live
 * OAuth tokens.
 */
function match(
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter((one) => one.length > 0);

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const shape = route.path.split('/').filter((one) => one.length > 0);
    if (shape.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (const [at, segment] of shape.entries()) {
      const given = parts[at]!;
      if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(given);
      else if (segment !== given) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    path: '/v1/connections',
    needs: READS,
    async run({ assertion, root, readers }) {
      return json({
        workspace: assertion.workspace,
        connections: await readers.connections(root),
      });
    },
  },
  {
    method: 'GET',
    path: '/v1/profiles',
    needs: READS,
    async run({ assertion, root, readers }) {
      const { profiles, unreadable } = await readers.profiles(root);
      return json({ workspace: assertion.workspace, profiles, unreadable });
    },
  },
  {
    method: 'POST',
    path: '/v1/profiles',
    needs: WIDENS,
    async run({ writers, env, body }) {
      let named: unknown;
      try {
        named = await body();
      } catch {
        return json({ error: 'That request body is not JSON.' }, 400);
      }

      const name = (named as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || !PROFILE_NAME.test(name)) {
        // Checked here rather than left to the writer, so a malformed name is a
        // 400 naming the rule instead of whatever a path error reads like.
        return json(
          {
            error:
              'A profile name is lowercase letters, digits, hyphens and underscores, ' +
              'starting with a letter.',
          },
          400,
        );
      }

      try {
        const created = await writers.create(name, {
          // A managed workspace declares exactly one target and it is not the
          // caller's to choose (ADR-052: a workspace is a target).
          targets: [MANAGED_TARGET],
          // Nobody is at a terminal. A command that would prompt must refuse
          // instead of blocking on a stdin that will never answer.
          nonInteractive: true,
          env,
        });
        return json({ profile: created.name }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A name already taken is the caller's to fix and the one failure here
        // that is not ours, so it says so rather than becoming a 503.
        if (/already exists/i.test(message)) {
          return json({ error: `A profile called "${name}" already exists.` }, 409);
        }
        throw error;
      }
    },
  },
  {
    method: 'PUT',
    path: '/v1/profiles/:profile/grants/:connection',
    needs: WIDENS,
    async run({ writers, env, params }) {
      const profile = params['profile'] ?? '';
      const connection = params['connection'] ?? '';

      if (!PROFILE_NAME.test(profile)) {
        return json({ error: 'That is not a profile name.' }, 400);
      }
      if (!CONNECTION_REF.test(connection)) {
        return json(
          { error: 'A connection reference is "<provider>.<id>", lowercase.' },
          400,
        );
      }

      // The third gate, and read before anything is written. The role says who
      // the caller is and the scope says what they authorised this client to
      // do; this is the profile's own answer, and a profile closed to agents
      // refuses an admin holding every scope.
      if (!(await writers.agentMayManage(profile, env))) {
        return json(
          {
            error:
              `The profile "${profile}" is not open to being changed by an agent. ` +
              'Its `agent_management` is set to deny; a person can still change it from the ' +
              'dashboard or the CLI.',
          },
          403,
        );
      }

      try {
        const granted = await writers.grant(connection, profile, env);
        // Already granted is not a failure. Asking twice is an ordinary thing
        // for an agent to do and the answer is the same either way.
        return json({ connection, profile, alreadyGranted: granted === null }, 200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/holds no connection/i.test(message)) {
          return json({ error: `This workspace holds no connection "${connection}".` }, 404);
        }
        throw error;
      }
    },
  },
];
