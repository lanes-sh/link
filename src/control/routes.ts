import type { Logger } from '#connectivity';
import { connectionSummaries, type ConnectionSummary } from '#cli/commands/connection-list.ts';
import { loadWorkspaceProfiles } from '#profile';
import { READS, WIDENS, permits, workspaceRootFor } from './authorise.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * The control plane's HTTP surface.
 *
 * Every route here reaches configuration for exactly one workspace, and which
 * one is decided by a signed statement rather than by anything the caller
 * wrote. That is the property the whole component is built around, so it is
 * worth saying where it lives: `workspaceRootFor` takes the verified assertion
 * and nothing else, and no route reads a workspace from a path, a query or a
 * body. A caller may name one; it changes nothing, and a test says so.
 *
 * This is **not** the endpoint. ADR-007 says a running instance never mutates
 * its own configuration and exposes no administrative API, and that is still
 * true: the thing an agent talks to has none of these routes, and this service
 * serves no MCP. They are two processes with two jobs, and the separation is
 * why the wall ADR-007 built is unmoved by a control plane existing.
 */

/** A profile as the control plane reports it: shape, never content. */
export interface ProfileSummary {
  readonly name: string;
  readonly grants: number;
  readonly members: number;
}

export interface ProfilesResult {
  readonly profiles: readonly ProfileSummary[];
  /** Named rather than dropped: a profile that will not parse is the answer. */
  readonly unreadable: readonly { profile: string; reason: string }[];
}

/**
 * What a route needs from a workspace, injectable at the composition root.
 *
 * The defaults are the real readers. They are parameters because a route test
 * is about the gate — who is turned away, and which root the reader was handed
 * — and standing a workspace up on disk to assert a 403 would test the fixture.
 */
export interface WorkspaceReaders {
  connections(root: string): Promise<readonly ConnectionSummary[]>;
  profiles(root: string): Promise<ProfilesResult>;
}

export const liveReaders: WorkspaceReaders = {
  connections: (root) => connectionSummaries(root),
  async profiles(root) {
    const { loaded, unreadable } = await loadWorkspaceProfiles(root);
    return {
      profiles: loaded.map((one) => ({
        name: one.profile,
        grants: one.config.grants.length,
        members: one.config.members.length,
      })),
      unreadable,
    };
  },
};

export interface ControlRoutesOptions {
  readonly verifier: { verify(token: string): Promise<ControlAssertion | null> };
  readonly log: Logger;
  readonly readers?: WorkspaceReaders;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export function createControlRoutes(options: ControlRoutesOptions): {
  fetch(request: Request): Promise<Response>;
} {
  const readers = options.readers ?? liveReaders;

  return {
    async fetch(request) {
      const url = new URL(request.url);

      // Unknown paths are refused before the credential is looked at. A caller
      // probing for routes should not be able to tell a path that exists from
      // one that does not by which of them costs a signature verification.
      const route = ROUTES.find(
        (one) => one.method === request.method && one.path === url.pathname,
      );
      if (!route) return json({ error: 'not_found' }, 404);

      const header = request.headers.get('authorization') ?? '';
      const [scheme, token] = header.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) {
        return json({ error: 'unauthenticated' }, 401);
      }

      const assertion = await options.verifier.verify(token);
      if (assertion === null) {
        // One answer for every way a statement can fail to convince, for the
        // reason the verifier returns null rather than a reason: a caller told
        // which check failed learns which attempt got closer.
        options.log.warn('rejected a control assertion', { path: url.pathname });
        return json({ error: 'unauthenticated' }, 401);
      }

      const refusal = permits(assertion, route.needs);
      if (refusal) return json({ error: refusal.message }, refusal.status);

      const root = workspaceRootFor(assertion);

      try {
        return await route.run({ assertion, root, readers });
      } catch (error) {
        // The workspace, not the caller: a bucket that would not answer, a
        // profile mid-write. Reported without its message, which can carry a
        // path or a bucket name the caller has no business learning.
        options.log.error('a control route failed', {
          path: url.pathname,
          workspace: assertion.workspace,
          message: error instanceof Error ? error.message : String(error),
        });
        return json({ error: 'unavailable' }, 503);
      }
    },
  };
}

interface RouteContext {
  readonly assertion: ControlAssertion;
  readonly root: string;
  readonly readers: WorkspaceReaders;
}

interface Route {
  readonly method: string;
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
    async run() {
      // Reserved so the gate above it is exercised and reviewed before it does
      // anything. Adding a profile writes configuration, which is what WIDENS
      // is for, and it lands with the rest of the mutations.
      return json({ error: 'not_implemented' }, 501);
    },
  },
];
