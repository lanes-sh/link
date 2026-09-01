import { currentIdToken, type FetchLike } from './login.ts';
import { readSession } from './session.ts';

/**
 * The people a Lanes workspace already holds.
 *
 * A profile's `members:` is a *selection from* this list, not a second list
 * beside it. Membership of a workspace is managed on the dashboard — invited,
 * accepted, given a role, removed — and reproducing any of that here would be a
 * second place to say who somebody is, which is the failure this whole release
 * is about on the connection axis.
 *
 * So the flow is: somebody is added to the workspace on the dashboard, and they
 * appear here the moment they accept. Granting them a profile is then a local
 * edit naming a subject the server already vouches for.
 *
 * **A pending invitation is not delegatable, and that is the useful part.** An
 * invited person has an email and no `user_uid` until they accept, so there is
 * no subject to write into a profile — and a `members:` entry naming a guess
 * would look like a working delegation right up until they tried to use it.
 * They are listed, marked pending, and refused.
 */

export interface WorkspaceMember {
  /** `lanes:<uid>`, or null while the invitation is unaccepted. */
  readonly subject: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly status: 'pending' | 'active';
  readonly displayName: string | null;
}

export interface MembersResult {
  readonly members: readonly WorkspaceMember[];
  /** Why the list is empty, when it is, so a caller can say something useful. */
  readonly unavailable: string | null;
}

/**
 * Everyone in the Lanes workspace this one is bound to.
 *
 * Returns a reason rather than throwing when it cannot answer. Every caller is a
 * listing or a validation that has something to say either way, and a network
 * failure while editing a local file should not be fatal — the endpoint checks
 * the subject at token time regardless.
 */
export async function workspaceMembers(
  lanesWorkspace: string | undefined,
  options: { fetch?: FetchLike; home?: string } = {},
): Promise<MembersResult> {
  if (lanesWorkspace === undefined) {
    return {
      members: [],
      unavailable: 'this workspace is not bound to a Lanes workspace',
    };
  }

  const session = await readSession(options.home);
  if (session === null) return { members: [], unavailable: 'not signed in' };

  const token = await currentIdToken({ ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.home ? { home: options.home } : {}) });
  if (token === null) return { members: [], unavailable: 'the session could not be refreshed' };

  const call = options.fetch ?? globalThis.fetch;

  const response = await call(`${session.apiUrl}/v1/workspaces/${lanesWorkspace}/members`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);

  if (response === null) return { members: [], unavailable: `${session.apiUrl} is unreachable` };
  if (!response.ok) {
    return { members: [], unavailable: `${session.apiUrl} answered ${response.status}` };
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: {
      user_uid?: unknown;
      email?: unknown;
      role?: unknown;
      status?: unknown;
      display_name?: unknown;
    }[];
  };

  return {
    members: (body.data ?? []).map((row) => ({
      // The subject a profile names is the uid with the prefix `subjectRef`
      // requires — the same string `lanes auth login` stores, derived the same
      // way so the two cannot disagree about who somebody is.
      subject: typeof row.user_uid === 'string' ? `lanes:${row.user_uid}` : null,
      email: typeof row.email === 'string' ? row.email : null,
      role: typeof row.role === 'string' ? row.role : 'member',
      status: row.status === 'active' ? 'active' : 'pending',
      displayName: typeof row.display_name === 'string' ? row.display_name : null,
    })),
    unavailable: null,
  };
}

/** How to show somebody whose subject is the only thing known about them. */
export function describeMember(member: WorkspaceMember): string {
  return member.displayName ?? member.email ?? member.subject ?? 'unknown';
}
