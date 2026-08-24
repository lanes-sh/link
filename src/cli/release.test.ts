import { describe, expect, test } from 'bun:test';
import { releaseState, staleLine } from './release.ts';

/**
 * How the installed version is compared against the published one.
 *
 * Pure on purpose, and tested here rather than through `update`, because the
 * interesting states are the ones a checkout cannot be in: this file is by
 * definition the newest version of itself, so `stale` is unreachable without
 * saying what the registry answered. The registry is not consulted here at all
 * — a suite that fails on an aeroplane is a suite people learn to ignore.
 *
 * The comparison degrades to `unknown` rather than throwing. `Bun.semver.order`
 * raises on anything it cannot parse, and a registry answering something
 * unexpected must not be able to take down `doctor`, `start`, and `deploy`,
 * which each print one line from this.
 */

describe('releaseState', () => {
  test('equal versions are current', () => {
    expect(releaseState('0.2.0', '0.2.0')).toBe('current');
  });

  test('a published version above the installed one is stale', () => {
    expect(releaseState('0.1.2', '0.2.0')).toBe('stale');
  });

  test('comparison is by precedence, not by string', () => {
    // '0.10.0' sorts below '0.9.0' as text, which is the bug a hand-rolled
    // comparator is most likely to ship with.
    expect(releaseState('0.9.0', '0.10.0')).toBe('stale');
    expect(releaseState('0.10.0', '0.9.0')).toBe('ahead');
  });

  test('a checkout ahead of the registry is not reported as behind', () => {
    // The state a contributor is in most of the time: the version bump has
    // merged but nothing has published yet. Telling them to update would be
    // both wrong and the message they see most often.
    expect(releaseState('0.3.0', '0.2.0')).toBe('ahead');
  });

  test('a prerelease is below the release it precedes', () => {
    expect(releaseState('0.2.0-rc.1', '0.2.0')).toBe('stale');
  });

  test('an unreachable registry is unknown, not current', () => {
    // `latest` is null on any failure. Reporting that as current would make a
    // dropped network look exactly like an up-to-date install.
    expect(releaseState('0.2.0', null)).toBe('unknown');
  });

  test('an unparseable version is unknown rather than an exception', () => {
    expect(releaseState('not-a-version', '0.2.0')).toBe('unknown');
    expect(releaseState('0.2.0', 'not-a-version')).toBe('unknown');
    expect(releaseState('', '0.2.0')).toBe('unknown');
  });
});

describe('staleLine', () => {
  test('names both versions and the command that acts on them', () => {
    const line = staleLine({ installed: '0.1.2', latest: '0.2.0', state: 'stale' });

    expect(line).toContain('0.1.2');
    expect(line).toContain('0.2.0');
    expect(line).toContain('lanes link update');
  });

  test('says nothing about any state but stale', () => {
    // Three commands print this line. Each of them printing "you are current"
    // on every run is noise, and printing "could not check" is worse — it is a
    // report about the network in the middle of a report about something else.
    for (const state of ['current', 'ahead', 'unknown'] as const) {
      expect(staleLine({ installed: '0.2.0', latest: '0.2.0', state })).toBeNull();
    }
  });
});
