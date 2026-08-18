import { describe, expect, test } from 'bun:test';
import { accountId, defaultServiceName, proposedName } from './survey.ts';

/**
 * The names a first deploy proposes.
 *
 * The prompts themselves need a terminal and are not exercised here. What is, is
 * every value derived from an answer — because those are written into a profile
 * and then into argv, and a name that is one character too long fails in a step
 * that tolerates failure.
 */

describe('the default service name', () => {
  test('says what it is and which profile it serves', () => {
    // `personal` alone, in a project holding a dozen unrelated services, says
    // neither.
    expect(defaultServiceName('personal')).toBe('lanes-link-personal-mcp');
    expect(defaultServiceName('work')).toBe('lanes-link-work-mcp');
  });

  test('two profiles in one project do not collide', () => {
    expect(defaultServiceName('personal')).not.toBe(defaultServiceName('work'));
  });

  test('it is a legal Cloud Run service name', () => {
    // Lowercase letters, digits and hyphens; starts with a letter; 49 max.
    for (const profile of ['personal', 'work', 'a-very-long-profile-name']) {
      const service = defaultServiceName(profile);
      expect(service).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(service.length).toBeLessThanOrEqual(49);
    }
  });
});

describe('the globally-unique name, for the project and its bucket', () => {
  test('is lanes-link plus five random letters', () => {
    expect(proposedName()).toMatch(/^lanes-link-[a-z]{5}$/);
  });

  test('one suffix names both, so a deployment is one string either way round', () => {
    // The survey generates the suffix once and offers the project name back as
    // the bucket default. Two independent draws would mean a project and a
    // bucket with no way to tell they belong together.
    expect(proposedName('a1b2c3')).toBe('lanes-link-a1b2c3');
  });

  test('no profile name in it — that is what the service name carries', () => {
    // A project holding two profiles' deployments distinguishes them by service
    // name; the project and bucket are per-deployment, not per-profile.
    expect(proposedName('a1b2c3')).not.toContain('personal');
  });

  test('it is legal as both a project id and a bucket name', () => {
    // Project ids are 6-30 characters and may not end in a hyphen; buckets are
    // 3-63. One string has to satisfy both.
    const name = proposedName();

    expect(name.length).toBeGreaterThanOrEqual(6);
    expect(name.length).toBeLessThanOrEqual(30);
    expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });

  test('two draws differ, which is the entire point of the suffix', () => {
    const names = new Set(Array.from({ length: 50 }, () => proposedName()));

    // Five letters is ~12M combinations; 50 draws colliding means the suffix is
    // not random, which is how two machines deploy into one another's bucket.
    expect(names.size).toBe(50);
  });
});

describe('the runtime service account derived from it', () => {
  test('is the service plus -run, when that fits', () => {
    expect(accountId('lanes-link-personal-mcp')).toBe('lanes-link-personal-mcp-run');
  });

  test('is clamped to 30 characters, because a service name may be 49', () => {
    // The two limits differ, so a legal service name can derive an illegal
    // account — and `iam service-accounts create` is a tolerated failure, so the
    // deploy would carry on and roll a revision with no identity at all.
    const long = accountId('lanes-link-a-very-long-profile-name-mcp');

    expect(long.length).toBeLessThanOrEqual(30);
    expect(long).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    expect(long.endsWith('-run')).toBe(true);
  });

  test('never leaves a doubled or trailing hyphen where it cut', () => {
    // `foo--run` and `foo--` are both rejected by the id grammar, so trimming
    // has to land on a character rather than on the truncation point.
    expect(accountId('lanes-link-demo-profile-x-mcp')).not.toContain('--');
  });
});
