import { describe, expect, test } from 'bun:test';
import { silentLogger } from './logging.ts';
import { staleness, RELOAD_PROBE_MS, type Staleness } from './staleness.ts';
import type { Generations } from './generations.ts';

/**
 * When a warm instance re-reads config nobody told it about.
 *
 * The rows these cover are the ones ADR-029's error path cannot: a member
 * added, a grant narrowed, a policy denied, a profile removed. None of them
 * moves a tool name, so `Generation.knows` never misses for them and the
 * instance that did not get the POST would otherwise serve the old answer until
 * unrelated traffic happened to miss.
 */

function rig(options: { stamp?: () => string | null; reloaded?: boolean } = {}): {
  stale: Staleness;
  reloads: () => number;
  tick: (ms: number) => void;
} {
  let clock = 1_000_000;
  let reloads = 0;

  const generations = {
    reload: async () => {
      reloads++;
      return { reloaded: options.reloaded ?? true, epoch: reloads, profiles: [], tools: 0 };
    },
  } as unknown as Generations;

  const stale = staleness({
    generations,
    log: silentLogger(),
    // `digest()` rather than a free `stamp()`, because the guard has to be able
    // to provoke a pass: the authenticator chain stops at its first success, so
    // on a static-token workspace the resolver is never otherwise asked.
    ...(options.stamp ? { members: { digest: async () => options.stamp!() } } : {}),
    now: () => clock,
  });

  return {
    stale,
    reloads: () => reloads,
    tick: (ms) => {
      clock += ms;
    },
  };
}

describe('catching up on a config that moved', () => {
  test('does nothing before any membership pass has run', async () => {
    // `stamp()` is null until a pass completes, and a null is not a change. An
    // instance serving its first request must not reload for want of a digest.
    const { stale, reloads } = rig({ stamp: () => null });

    expect(await stale.catchUp()).toBe(false);
    expect(reloads()).toBe(0);
  });

  test('takes the first digest as what this instance booted with', async () => {
    // It opened its generation by reading the same declared config a moment
    // earlier, so the first observation is agreement rather than news.
    const { stale, reloads } = rig({ stamp: () => 'aaa' });

    expect(await stale.catchUp()).toBe(false);
    expect(reloads()).toBe(0);
  });

  test('reloads when the digest moves, and not again while it holds still', async () => {
    let digest = 'aaa';
    const { stale, reloads, tick } = rig({ stamp: () => digest });

    await stale.catchUp();
    expect(reloads()).toBe(0);

    digest = 'bbb';
    expect(await stale.catchUp()).toBe(true);
    expect(reloads()).toBe(1);

    // The comparison is against what is being served, so a digest that has
    // already been acted on is not news however many requests arrive.
    tick(RELOAD_PROBE_MS);
    expect(await stale.catchUp()).toBe(false);
    tick(RELOAD_PROBE_MS);
    expect(await stale.catchUp()).toBe(false);
    expect(reloads()).toBe(1);
  });

  test('a reload that did not land is retried, rather than assumed', async () => {
    // The reason this compares against the *served* digest and not against the
    // previous observation. `Generations.reload` keeps the old generation and
    // returns `reloaded: false` when the config will not open; advancing on
    // anything but success would leave the endpoint believing it had caught up
    // and never trying again until the file moved a second time.
    let digest = 'aaa';
    const { stale, reloads, tick } = rig({ stamp: () => digest, reloaded: false });

    await stale.catchUp();
    digest = 'bbb';

    expect(await stale.catchUp()).toBe(false);
    expect(reloads()).toBe(1);

    tick(RELOAD_PROBE_MS);
    expect(await stale.catchUp()).toBe(false);
    expect(reloads()).toBe(2);
  });

  test('a bind with no resolver behaves exactly as it did before', async () => {
    // The harness and the stdio bind have no `workspaceMembers`, and the field
    // is optional so that costs them nothing rather than a special case.
    const { stale, reloads } = rig();

    expect(await stale.catchUp()).toBe(false);
    expect(reloads()).toBe(0);
  });
});

describe('one clock for both reasons', () => {
  test('a reload is bounded however it was provoked', async () => {
    const { stale, reloads, tick } = rig();

    expect(await stale.reload('unknown-tool')).toBe(true);
    expect(await stale.reload('unknown-tool')).toBe(false);
    expect(reloads()).toBe(1);

    tick(RELOAD_PROBE_MS);

    expect(await stale.reload('unknown-tool')).toBe(true);
    expect(reloads()).toBe(2);
  });

  test('a digest-driven reload leaves the tool-name probe nothing to do', async () => {
    // Not a defect: the generation the probe would be provoking is the one that
    // just landed. `Generations.reload` is serialised on its own, so what the
    // shared clock prevents is two provocations for one request rather than two
    // generations.
    let digest = 'aaa';
    const { stale, reloads } = rig({ stamp: () => digest });

    await stale.catchUp();
    digest = 'bbb';
    expect(await stale.catchUp()).toBe(true);

    expect(await stale.reload('unknown-tool')).toBe(false);
    expect(reloads()).toBe(1);
  });

  test('the tool-name probe still works when nothing is watching the digest', async () => {
    // ADR-029's error path, unchanged. It is the only trigger on a bind with no
    // resolver, and the one this refactor must not have broken.
    const { stale, reloads } = rig();

    expect(await stale.reload('unknown-tool')).toBe(true);
    expect(reloads()).toBe(1);
  });
});
