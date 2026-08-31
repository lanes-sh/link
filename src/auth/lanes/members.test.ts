import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeMember, workspaceMembers } from './members.ts';
import { sessionPath } from './session.ts';

/**
 * Asking the Lanes workspace who it holds.
 *
 * The point of this file is that a profile's `members:` is a *selection from*
 * that list rather than a second list beside it — so the two properties worth
 * pinning are the mapping (a `user_uid` becomes the same `lanes:` subject that
 * `lanes auth login` stores) and the failure behaviour (a workspace that cannot
 * be reached says why, rather than reading as "holds nobody").
 */

const homes: string[] = [];

/** A `$HOME` holding a session, so the fetch has a token to present. */
async function signedIn(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-members-'));
  homes.push(root);
  await mkdir(join(root, '.lanes'), { recursive: true });
  await writeFile(
    sessionPath(root),
    JSON.stringify({
      subject: 'lanes:AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      email: 'owner@example.com',
      refreshToken: 'a-refresh-token',
      idToken: 'an-id-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      apiUrl: 'https://api.example.com',
    }),
  );
  return root;
}

afterAll(async () => {
  await Promise.all(homes.map((one) => rm(one, { recursive: true, force: true })));
});

type Call = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe('a workspace that is not bound', () => {
  test('says so, rather than reporting an empty workspace', async () => {
    // The distinction a caller has to make: `local` has no member list to ask,
    // which is not the same as a Lanes workspace that holds nobody.
    const result = await workspaceMembers(undefined);

    expect(result.members).toEqual([]);
    expect(result.unavailable).toContain('not bound');
  });
});

describe('the mapping', () => {
  test('a uid becomes the subject a profile can name', async () => {
    // The one fact both halves depend on. `lanes auth login` derives the
    // subject the same way, so a member added on the dashboard and a member
    // signing in on this machine are the same string.
    const call: Call = async () =>
      Response.json({
        data: [
          { user_uid: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBB', email: 'her@example.com', role: 'admin', status: 'active' },
        ],
      });

    const result = await workspaceMembers('a-workspace', { fetch: call, home: await signedIn() });

    expect(result.unavailable).toBeNull();
    expect(result.members[0]?.subject).toBe('lanes:BBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(result.members[0]?.role).toBe('admin');
  });

  test('an unaccepted invitation has no subject, and is marked rather than dropped', async () => {
    // Listed, because the operator can see the person on the dashboard and
    // would otherwise be told to invite somebody who is already invited. Not
    // delegatable, because there is no subject yet to write into a profile.
    const call: Call = async () =>
      Response.json({ data: [{ email: 'pending@example.com', role: 'editor', status: 'pending' }] });

    const result = await workspaceMembers('a-workspace', { fetch: call, home: await signedIn() });

    expect(result.members[0]?.subject).toBeNull();
    expect(result.members[0]?.status).toBe('pending');
    expect(describeMember(result.members[0]!)).toBe('pending@example.com');
  });

  test('presents the token the API issued, not the workspace id', async () => {
    let seen: string | undefined;
    const call: Call = async (input, init) => {
      seen = String((init?.headers as Record<string, string>)['authorization']);
      expect(String(input)).toBe('https://api.example.com/v1/workspaces/a-workspace/members');
      return Response.json({ data: [] });
    };

    await workspaceMembers('a-workspace', { fetch: call, home: await signedIn() });

    expect(seen).toBe('Bearer an-id-token');
  });
});

describe('when the answer cannot be had', () => {
  test('not signed in reads as unavailable, not as empty', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'lanes-members-'));
    homes.push(empty);

    const result = await workspaceMembers('a-workspace', { home: empty });

    expect(result.unavailable).toBe('not signed in');
  });

  test('a refusal names the status, so the reason reaches the operator', async () => {
    const call: Call = async () => new Response('nope', { status: 403 });

    const result = await workspaceMembers('a-workspace', { fetch: call, home: await signedIn() });

    expect(result.unavailable).toContain('403');
  });

  test('an unreachable API is a reason rather than a throw', async () => {
    // Deliberate: this is consulted while editing a local file, and a network
    // failure there should warn rather than block. The endpoint verifies the
    // subject when it mints a token regardless.
    const call: Call = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };

    const result = await workspaceMembers('a-workspace', { fetch: call, home: await signedIn() });

    expect(result.unavailable).toContain('unreachable');
  });
});
