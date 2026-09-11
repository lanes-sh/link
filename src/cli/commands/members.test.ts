import { describe, expect, test } from 'bun:test';
import { delegationNote, manageRefusal } from './members.ts';
import type { WorkspaceMember } from '#auth/lanes/members.ts';

/**
 * Who may edit the list that decides who reaches a profile.
 *
 * The roles are the Lanes workspace's, because that is where they are already
 * managed: `admin` manages the workspace and who is in it, `editor` works
 * inside it. A profile's own `role: owner | member` is deliberately not this
 * check — a second role system beside `members:` would need precedence rules
 * between two answers to one question.
 *
 * **Worth restating what this is.** `members:` is a line in a YAML file, and
 * anybody who can run the command can open the file. The rule makes widening
 * your own reach deliberate rather than incidental, and names somebody who can
 * do it for you; the boundary that holds is who may write the workspace's
 * files. These tests pin the rule, not a guarantee.
 */

const member = (subject: string, role: string): WorkspaceMember =>
  ({ subject, role, status: 'active' }) as WorkspaceMember;

const HER = 'lanes:HER';
const ADMIN = 'lanes:ADMIN';

describe('editing who may consume a profile', () => {
  test('an admin of the workspace may', () => {
    const held = [member(HER, 'admin'), member(ADMIN, 'admin')];

    expect(manageRefusal(held, HER, 'cloud')).toBeNull();
  });

  test('an editor may not, and is told who can', () => {
    const held = [member(HER, 'editor'), member(ADMIN, 'admin')];

    const refusal = manageRefusal(held, HER, 'cloud');

    expect(refusal).not.toBeNull();
    expect(refusal).toContain('admins');
    // The message names somebody who can, because "ask an admin" without one is
    // advice a person cannot act on.
    expect(refusal).toContain(ADMIN);
  });

  test('the refusal says what is still theirs, because most of it is', () => {
    // An editor loses nothing they were doing. They consume every profile that
    // lists them and manage the data inside it; what moves is the list itself.
    const held = [member(HER, 'editor'), member(ADMIN, 'admin')];

    expect(manageRefusal(held, HER, 'cloud')).toContain('profiles that already list you');
  });

  test('a workspace with no admin says so, rather than naming nobody', () => {
    const held = [member(HER, 'editor')];

    expect(manageRefusal(held, HER, 'cloud')).toContain('no admin');
  });

  test('a subject the workspace does not list is left to the delegation check', () => {
    // Not refused here. It is the ordinary state of a workspace whose list
    // cannot name this caller, and `assertDelegatable` is the check with an
    // answer for it — refusing twice for one cause produces the worse message.
    const held = [member(ADMIN, 'admin')];

    expect(manageRefusal(held, HER, 'cloud')).toBeNull();
  });

  test('nobody signed in is left to the same check', () => {
    const held = [member(ADMIN, 'admin')];

    expect(manageRefusal(held, undefined, 'cloud')).toBeNull();
  });

  test('the workspace is named, because a person may hold several', () => {
    const held = [member(HER, 'editor'), member(ADMIN, 'admin')];

    expect(manageRefusal(held, HER, 'cloud')).toContain('"cloud"');
  });
});

/**
 * What is said about a uid the bound workspace does not list — and, more to the
 * point, that nothing is refused.
 *
 * `assertDelegatable` used to refuse twice: unbound, everybody but the operator;
 * bound, everybody off the Lanes workspace's roster. Both are gone. An admin
 * attaches a uid and the endpoint checks, per request, that the uid calling it
 * is on the profile — there is no third thing to establish here.
 *
 * Each refusal looked like a safety property and was not. It is not a boundary
 * (ADR-079: `members:` is a line in a YAML file and whoever runs the command can
 * open it); the shape is checked by `subjectRef` either way, which is also what
 * keeps a pasted credential out of the field; a wrong uid writes a row nothing
 * can match, because no assertion names that subject; and the remedy it printed
 * — add `lanes_workspace:` — named a field no command writes, in a file that
 * lives in the bucket once a target is deployed.
 */
describe('a uid the workspace does not list', () => {
  const HIM = 'lanes:HIM';

  test('a listed subject draws no note at all', () => {
    const held = [member(HER, 'admin'), member(HIM, 'editor')];

    expect(delegationNote(held, HIM, 'cloud')).toBeNull();
  });

  test('an unlisted one is written anyway, and the note says to check it', () => {
    const held = [member(HER, 'admin')];

    const note = delegationNote(held, HIM, 'cloud');

    expect(note).not.toBeNull();
    // The two things the operator needs: it happened, and why it might be wrong.
    expect(note).toContain('written either way');
    expect(note).toContain('nothing can');
  });

  test('a pending invitation is named, because that one looks like it worked', () => {
    // The person exists and the operator can see them on the dashboard. There is
    // still no uid, so a guessed row reads as a working delegation right up until
    // they try to use it.
    const held: WorkspaceMember[] = [
      member(HER, 'admin'),
      { subject: null, email: 'ada.lovelace@example.com', role: 'editor', status: 'pending', displayName: null },
    ];

    const note = delegationNote(held, HIM, 'cloud');

    expect(note).toContain('not accepted an invitation');
    expect(note).toContain('ada.lovelace@example.com');
  });

  test('no pending invitations leaves that sentence out', () => {
    const held = [member(HER, 'admin')];

    expect(delegationNote(held, HIM, 'cloud')).not.toContain('invitation');
  });
});
