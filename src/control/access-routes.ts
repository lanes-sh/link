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
 * The routes whose subject is what a profile reaches, and who reaches it.
 *
 * Grants and policy rules decide which accounts and which capabilities;
 * members decide which people. Together they are the authorization surface a
 * profile expresses, which is why they sit in one file and profile lifecycle
 * sits in another.
 */
export const ACCESS_ROUTES: readonly Route[] = [
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

      // The third gate, read before anything is written. The role says who the
      // caller is and the scope says what they authorised this client to do;
      // this is the profile's own answer, and it refuses an admin holding every
      // scope.
      const closed = await profileOpenToAgents(profile, writers, env);
      if (closed) return closed;

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
  {
    method: 'DELETE',
    path: '/v1/profiles/:profile/grants/:connection',
    needs: WIDENS,
    async run({ writers, env, params }) {
      const profile = params['profile'] ?? '';
      const connection = params['connection'] ?? '';
      if (!PROFILE_NAME.test(profile) || !CONNECTION_REF.test(connection)) {
        return json({ error: 'That is not a profile and connection pair.' }, 400);
      }

      const closed = await profileOpenToAgents(profile, writers, env);
      if (closed) return closed;

      const revoked = await writers.revoke(connection, profile, env);
      // The account is untouched and every other profile granting it still
      // reaches it — said here because `revoke` and `disconnect` are the pair
      // people confuse, and confusing them loses a mailbox.
      return json({ profile, connection, wasGranted: revoked }, 200);
    },
  },
  {
    method: 'PUT',
    // `:effect` is a path segment rather than a body field so the route table
    // shows both, and so `approval_required` — reserved and failing closed in
    // the policy model — is not a route at all rather than a value refused
    // after the fact.
    path: '/v1/profiles/:profile/policy/:effect/:capability',
    needs: WIDENS,
    async run({ writers, env, params, body }) {
      const profile = params['profile'] ?? '';
      const effect = params['effect'] ?? '';
      const capability = params['capability'] ?? '';

      if (!PROFILE_NAME.test(profile)) return json({ error: 'That is not a profile name.' }, 400);
      if (effect !== 'allow' && effect !== 'deny') return notFound();
      if (!CAPABILITY.test(capability)) {
        return json({ error: 'That is not a capability id.' }, 400);
      }

      // A rule governs one connection (ADR-058), and with two mailboxes granted
      // there is no answer to "which one" that is not a guess.
      let named: unknown;
      try {
        named = await body();
      } catch {
        return json({ error: 'That request body is not JSON.' }, 400);
      }
      const connection = (named as { connection?: unknown } | null)?.connection;
      if (typeof connection !== 'string' || !CONNECTION_REF.test(connection)) {
        return json({ error: 'A "connection" is required: a rule governs one connection.' }, 400);
      }

      const closed = await profileOpenToAgents(profile, writers, env);
      if (closed) return closed;

      try {
        const applied = await writers.policy(effect, capability, connection, profile, env);
        return json({ profile, capability, effect, alreadyDeclared: applied === null }, 200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not grant/i.test(message)) {
          return json({ error: `"${profile}" does not grant "${connection}".` }, 409);
        }
        throw error;
      }
    },
  },
  {
    method: 'PUT',
    path: '/v1/profiles/:profile/members/:subject',
    needs: WIDENS,
    async run({ writers, env, params, body }) {
      const profile = params['profile'] ?? '';
      const subject = params['subject'] ?? '';

      if (!PROFILE_NAME.test(profile)) return json({ error: 'That is not a profile name.' }, 400);
      if (!SUBJECT.test(subject)) {
        // A bare uid would look like a working delegation and reach nothing.
        return json({ error: 'A member is named "lanes:<uid>".' }, 400);
      }

      let role: 'owner' | 'member' = 'member';
      try {
        const named = (await body()) as { role?: unknown } | null;
        if (named?.role === 'owner') role = 'owner';
      } catch {
        // No body is the ordinary case: `member` is the default a profile takes.
      }

      const closed = await profileOpenToAgents(profile, writers, env);
      if (closed) return closed;

      const added = await writers.addMember(subject, role, profile, env);
      return json({ profile, subject, role, alreadyListed: added === null }, 200);
    },
  },
  {
    method: 'DELETE',
    path: '/v1/profiles/:profile/members/:subject',
    needs: WIDENS,
    async run({ writers, env, params }) {
      const profile = params['profile'] ?? '';
      const subject = params['subject'] ?? '';
      if (!PROFILE_NAME.test(profile) || !SUBJECT.test(subject)) {
        return json({ error: 'That is not a profile and subject pair.' }, 400);
      }

      const closed = await profileOpenToAgents(profile, writers, env);
      if (closed) return closed;

      const removed = await writers.removeMember(subject, profile, env);
      // Worth the caller knowing: a token they already hold keeps working until
      // it expires, because membership is read when one is minted (ADR-060).
      return json({ profile, subject, wasListed: removed }, 200);
    },
  },
  {
    method: 'DELETE',
    path: '/v1/profiles/:profile',
    needs: WIDENS,
    async run({ writers, env, params }) {
      const profile = params['profile'] ?? '';
      if (!PROFILE_NAME.test(profile)) return json({ error: 'That is not a profile name.' }, 400);

      const closed = await profileOpenToAgents(profile, writers, env);
      if (closed) return closed;

      const outcome = await writers.removeProfileNamed(profile, env);
      if (outcome.survived > 0) {
        // A non-zero survivor means a credential is still live. Reporting 200
        // would tell somebody their account was cleaned up when it was not.
        return json(
          {
            error:
              `Removed "${profile}", but ${outcome.survived} item(s) are still there. ` +
              'A credential may still be live; check the workspace.',
          },
          500,
        );
      }
      return json({ profile, removed: true }, 200);
    },
  },
];
