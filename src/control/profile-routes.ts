import { WIDENS, READS } from './authorise.ts';
import { MANAGED_TARGET } from './workspace.ts';
import {
  CAPABILITY,
  CONNECTION_REF,
  PROFILE_NAME,
  SUBJECT,
  json,
  notFound,
  profileOpenToAgents,
  type Route,
} from './routing.ts';

/**
 * The routes whose subject is a profile itself — listing, creating, removing.
 *
 * Split from `./access-routes.ts` when the table outgrew one file, along the
 * line the two already had: this is whether a profile *exists*, and that is
 * what it reaches and who reaches it. A reviewer checking that removal is
 * admin-only reads one of these files rather than scrolling past the other.
 */
export const PROFILE_ROUTES: readonly Route[] = [
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
];
