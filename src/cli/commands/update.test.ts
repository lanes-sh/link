import { describe, expect, test } from 'bun:test';
import { bunGlobalRoot, updatePlan, type UpdateInput } from './update.ts';

/**
 * What `lanes link update` decides to do, without doing any of it.
 *
 * The reason this decision is a separate function is that the alternative is a
 * test which replaces the copy of this CLI on the machine running the suite.
 * Every branch is reachable from here with no network and no subprocess.
 *
 * Two of the branches are the ones worth having. A checkout must be refused:
 * `bun link` puts it on the same PATH entry a published install would occupy, so
 * installing from the registry would leave two copies and no indication of which
 * one answers. And an install that is not under Bun's global prefix — an
 * `npm i -g`, which nothing documents but nothing prevents — must be reported
 * before the install rather than discovered afterwards, because Bun will write a
 * second copy elsewhere and leave PATH order to decide the winner.
 */

const BUN_GLOBAL = '/home/someone/.bun/install/global';
const INSTALLED = `${BUN_GLOBAL}/node_modules/@lanes-sh/link`;

function input(overrides: Partial<UpdateInput> = {}): UpdateInput {
  return {
    installed: '0.1.2',
    latest: '0.2.0',
    state: 'stale',
    root: INSTALLED,
    bunGlobal: BUN_GLOBAL,
    ...overrides,
  };
}

describe('updatePlan', () => {
  test('a stale install under Bun’s prefix installs, with nothing to warn about', () => {
    const decision = updatePlan(input());

    expect(decision.action).toBe('install');
    expect(decision.install).toEqual(['install', '-g', '@lanes-sh/link']);
    expect(decision.warning).toBeNull();
    expect(decision.message).toContain('0.2.0');
  });

  test('a current install runs nothing', () => {
    const decision = updatePlan(input({ state: 'current', installed: '0.2.0' }));

    expect(decision.action).toBe('current');
    expect(decision.install).toBeNull();
  });

  test('an install ahead of the registry runs nothing', () => {
    const decision = updatePlan(input({ state: 'ahead', installed: '0.3.0' }));

    expect(decision.action).toBe('ahead');
    expect(decision.install).toBeNull();
  });

  test('an unreachable registry runs nothing and says so', () => {
    const decision = updatePlan(input({ state: 'unknown', latest: null }));

    expect(decision.action).toBe('unknown');
    expect(decision.install).toBeNull();
    expect(decision.message).toContain('registry');
  });

  test('a checkout is refused, and told the thing that does update it', () => {
    // `installRoot` returns the repository root here, which holds no
    // `node_modules` segment. Installing from npm over a `bun link`ed checkout
    // is the one outcome that leaves someone unable to tell which code ran.
    const decision = updatePlan(input({ root: '/home/someone/dev/link' }));

    expect(decision.action).toBe('checkout');
    expect(decision.install).toBeNull();
    expect(decision.message).toContain('git pull');
  });

  test('a checkout is refused even when it is behind', () => {
    // The state a contributor on an old branch is in. Still a refusal: the
    // remedy is `git pull`, and it is not this command's to run.
    const decision = updatePlan(input({ root: '/home/someone/dev/link', state: 'stale' }));

    expect(decision.action).toBe('checkout');
  });

  test('an install outside Bun’s prefix still installs, but warns first', () => {
    const npm = '/usr/local/lib/node_modules/@lanes-sh/link';
    const decision = updatePlan(input({ root: npm }));

    expect(decision.action).toBe('install');
    expect(decision.install).toEqual(['install', '-g', '@lanes-sh/link']);
    expect(decision.warning).toContain(npm);
    expect(decision.warning).toContain('second copy');
  });

  test('the prefix check is on path segments, not on a substring', () => {
    // A sibling directory whose name starts with the prefix must not read as
    // being inside it — `startsWith` alone would call this one current.
    const decision = updatePlan(input({ root: `${BUN_GLOBAL}-backup/node_modules/@lanes-sh/link` }));

    expect(decision.warning).not.toBeNull();
  });
});

describe('bunGlobalRoot', () => {
  test('honours BUN_INSTALL', () => {
    expect(bunGlobalRoot({ BUN_INSTALL: '/opt/bun' })).toBe('/opt/bun/install/global');
  });

  test('falls back to ~/.bun when it is unset', () => {
    // Not compared against a literal path: the home directory is whoever is
    // running the suite, and hard-coding one is how this fails only in CI.
    expect(bunGlobalRoot({})).toEndWith('/.bun/install/global');
  });
});
