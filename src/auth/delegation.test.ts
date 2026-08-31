import { describe, expect, test } from 'bun:test';
import { mayReach, memberPrincipal, ownerPrincipal } from './index.ts';

/**
 * Who may act within a profile — ADR-060.
 *
 * The slot ADR-003 kept open on purpose. Policy has always been evaluated
 * against `(principal, capability, connection)` and always been handed the same
 * principal; this is the first release where the first of those three is a
 * person, and the check that reads it is one line ahead of policy in the
 * dispatcher.
 *
 * Two properties, and the second is the one worth having tests for. Being
 * refused is obvious. Being *invisible* is not: a member does not fail to call a
 * profile they are not on, they never see it in the `profile` enum — and a
 * filter that ever disagreed with the gate would be a leak in discovery, which
 * is still a leak.
 */

const SUBJECT = 'lanes:3QBmAxJLLrYSMTVUIeCN1SKFbdD3';

describe('a member reaches exactly the profiles that name them', () => {
  const member = memberPrincipal(SUBJECT, 'personal', ['personal', 'shared']);

  test('reaches a profile on the list', () => {
    expect(mayReach(member, 'personal')).toBe(true);
    expect(mayReach(member, 'shared')).toBe(true);
  });

  test('does not reach one that is not', () => {
    expect(mayReach(member, 'work')).toBe(false);
  });

  test('an empty list reaches nothing, because empty is nobody', () => {
    // Default deny on the identity axis. A profile whose `members:` is empty is
    // not "open to everyone" — it is a profile nobody may consume, which is the
    // state a hand-edit produces rather than one anybody is handed.
    const nobody = memberPrincipal(SUBJECT, 'personal', []);
    expect(mayReach(nobody, 'personal')).toBe(false);
  });

  test('carries the subject as its id, so the log names a person', () => {
    // The audit log records `principal`, and the whole point of this release is
    // that the value is a person rather than "whoever held the token".
    expect(member.id).toBe(SUBJECT);
    expect(member.kind).toBe('member');
  });
});

describe('the callers that are not people', () => {
  test('the owner principal reaches everything, as it always has', () => {
    // Unchanged behaviour, stated as a test because it is what every existing
    // registration relies on and what the CLI itself uses.
    const owner = ownerPrincipal('personal');

    expect(mayReach(owner, 'personal')).toBe(true);
    expect(mayReach(owner, 'work')).toBe(true);
  });

  test('an undefined list means the whole workspace, not an empty one', () => {
    // The distinction that would be a security hole if it inverted: `undefined`
    // is the machine token and the stdio pipe, both of which reach everything;
    // `[]` is a person delegated nothing. Reading one as the other in either
    // direction is the bug this pins.
    expect(mayReach({ id: 'ci', profile: 'personal', kind: 'machine' }, 'anything')).toBe(true);
    expect(
      mayReach({ id: 'x', profile: 'personal', kind: 'member', profiles: [] }, 'anything'),
    ).toBe(false);
  });
});
