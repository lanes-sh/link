import type { Authenticator, Principal } from '#auth';
import type { AuditTail } from './routes.ts';

/**
 * An authenticator that answers for one token.
 *
 * The routes take the endpoint's own `authenticate` so that who is calling is
 * an input rather than something they work out, and a test about filtering
 * wants to state the caller in one line rather than drive an OAuth flow to get
 * one. The real chain is exercised in `src/auth/remote.test.ts` and
 * `src/auth/index.test.ts`; this stands in for it everywhere the subject under
 * test is a route.
 *
 * It returns the principal verbatim, including its `profiles`, because that is
 * the field under test: `mayReach` reads it and the routes filter on the
 * answer.
 */
export function fixedAuthenticator(
  token: string,
  principal: Principal,
): Authenticator['authenticate'] {
  return async (header) =>
    header === `Bearer ${token}`
      ? { ok: true, principal }
      : { ok: false, reason: header ? 'invalid' : 'missing' };
}

type AuditRow = Awaited<ReturnType<AuditTail['tail']>>['events'][number];

/** A stub audit log that honours its query, and remembers what it was asked. */
export interface RecordingAuditTail extends AuditTail {
  /** The options of the most recent call, or `undefined` if never called. */
  readonly asked: { limit?: number; profiles?: readonly string[] } | undefined;
}

/**
 * An audit log that actually applies the predicate it is handed.
 *
 * The stubs this replaces were `tail: async () => [rows]` — ignoring their
 * options entirely. That is why `'the log narrows to one profile'` passed
 * against a route which never pushed the predicate down and filtered the rows
 * itself afterwards, with the limit already spent. A fixture that answers the
 * same two rows whatever it is asked cannot tell a route that filters from a
 * route that does not, so it reported the defect as working.
 *
 * It honours `limit` as well as `profiles`, in that order, because the order is
 * the thing under test: filter, then cut. A fixture that cut first would hide
 * the bug the same way the old one did.
 */
export function recordingAuditTail(rows: readonly AuditRow[]): RecordingAuditTail {
  let asked: { limit?: number; profiles?: readonly string[] } | undefined;

  return {
    get asked() {
      return asked;
    },
    tail: async (options) => {
      asked = options;
      const matching = options?.profiles
        ? rows.filter((row) => options.profiles!.includes(row.profile))
        : rows;
      const events = options?.limit === undefined ? matching : matching.slice(0, options.limit);
      return { events, complete: true, scanned: rows.length };
    },
  };
}
