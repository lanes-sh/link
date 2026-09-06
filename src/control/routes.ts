import type { Logger } from '#connectivity';
import {
  liveReaders,
  liveWriters,
  type ProfilesResult,
  type WorkspaceReaders,
  type WorkspaceWriters,
} from './commands.ts';
import { environmentFor } from './workspace.ts';
import { PROFILE_ROUTES } from './profile-routes.ts';
import { json, notFound, type Route } from './routing.ts';

// Re-exported so the server mounts one module rather than two: which paths
// this surface claims and what answers them are one fact from outside.
export { isControlPath } from './routing.ts';
import { ACCESS_ROUTES } from './access-routes.ts';
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
  readonly revoke?: WorkspaceWriters['revoke'];
  readonly policy?: WorkspaceWriters['policy'];
  readonly addMember?: WorkspaceWriters['addMember'];
  readonly removeMember?: WorkspaceWriters['removeMember'];
  readonly removeProfileNamed?: WorkspaceWriters['removeProfileNamed'];
  readonly storeConnection?: WorkspaceWriters['storeConnection'];
}












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
    ...(deps.revoke ? { revoke: deps.revoke } : {}),
    ...(deps.policy ? { policy: deps.policy } : {}),
    ...(deps.addMember ? { addMember: deps.addMember } : {}),
    ...(deps.removeMember ? { removeMember: deps.removeMember } : {}),
    ...(deps.removeProfileNamed ? { removeProfileNamed: deps.removeProfileNamed } : {}),
    ...(deps.storeConnection ? { storeConnection: deps.storeConnection } : {}),
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




const ROUTES: readonly Route[] = [...PROFILE_ROUTES, ...ACCESS_ROUTES];

