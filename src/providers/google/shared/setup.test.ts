import { describe, expect, test } from 'bun:test';
import { googleSetup } from './setup.ts';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const steps = (scopes: readonly string[] = GMAIL_SCOPES) =>
  googleSetup('Gmail', scopes).steps as string[];

const audience = () => steps().find((s) => s.trimStart().startsWith('AUDIENCE — User type'))!;

describe('the AUDIENCE step offers Internal before External', () => {
  // The regression this guards is a specific one: a blanket "choose EXTERNAL"
  // sends someone with a Workspace domain through publishing, a test-user list,
  // scope registration and the unverified-app warning to reach a client that
  // then expires its refresh tokens weekly if they miss the publish toggle.
  // Internal has none of those because it has no publishing status at all.
  test('names Internal, and names it first', () => {
    const step = audience();
    expect(step).toContain('INTERNAL');
    expect(step).toContain('EXTERNAL');
    expect(step.indexOf('INTERNAL')).toBeLessThan(step.indexOf('EXTERNAL'));
  });

  test('says what Internal removes, so the short path reads as shorter', () => {
    expect(audience()).toContain('no publishing status');
  });

  test('states the prerequisite, because Internal is absent without an organisation', () => {
    // "Internal" is Google's word for "inside my Workspace organisation", not
    // "private to me" — the step has to say so or a personal @gmail.com user
    // goes looking for an option that is not on their screen.
    const step = audience();
    expect(step).toContain('Workspace organisation');
    expect(step).toContain('not offered without a Workspace organisation');
  });
});

describe('the steps only Externals need are marked as such', () => {
  test('publishing, scope registration, and the verification cost all say EXTERNAL ONLY', () => {
    const marked = steps().filter((s) => s.includes('EXTERNAL ONLY'));
    // PUBLISH, DATA ACCESS, the unverified-app cost, and verification itself.
    expect(marked).toHaveLength(4);
  });

  test('DATA ACCESS says an Internal app can leave the page empty', () => {
    const step = steps().find((s) => s.includes('DATA ACCESS'))!;
    expect(step).toContain('EXTERNAL ONLY');
    expect(step).toContain('can stay empty');
  });

  test('still lists the scopes it was given, for the path that registers them', () => {
    const step = steps().find((s) => s.includes('DATA ACCESS'))!;
    for (const scope of GMAIL_SCOPES) expect(step).toContain(scope);
  });
});
