import { describe, expect, test } from 'bun:test';
import { Generations, type OpenedWorkspace } from './generations.ts';
import type { ProfileRuntime } from './mcp/index.ts';

/**
 * The generation lifecycle, at the level where it is actually decidable.
 *
 * Driving this over HTTP would mean racing a request against a reload and
 * hoping the interleaving lands where the assertion needs it. What the design
 * claims is narrower and exactly testable here: a generation replaced while a
 * request holds it is not closed until that request lets go.
 */

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/** A workspace that records whether it was closed, and how often. */
function stub(name: string): OpenedWorkspace & { closes: number } {
  const profiles = new Map<string, ProfileRuntime>([[name, {} as ProfileRuntime]]);
  return {
    profiles,
    closes: 0,
    close() {
      this.closes += 1;
      return Promise.resolve();
    },
  };
}

function generationsOver(
  first: OpenedWorkspace,
  next: () => Promise<OpenedWorkspace>,
): Generations {
  return new Generations(first, next, { primary: 'personal', log: SILENT });
}

describe('reload', () => {
  test('swaps in the reopened workspace and advances the epoch', async () => {
    const before = stub('before');
    const after = stub('after');
    const generations = generationsOver(before, () => Promise.resolve(after));

    expect(generations.current.epoch).toBe(0);
    expect(generations.current.names()).toEqual(['before']);

    const result = await generations.reload();

    expect(result.reloaded).toBe(true);
    expect(result.epoch).toBe(1);
    expect(result.profiles).toEqual(['after']);
    expect(generations.current.names()).toEqual(['after']);
  });

  test('closes the generation it replaced', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () => Promise.resolve(stub('after')));

    await generations.reload();

    expect(before.closes).toBe(1);
  });

  test('a failure keeps the previous generation serving, and says why', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () =>
      Promise.reject(new Error('profiles/personal.yaml: could not parse YAML')),
    );

    const result = await generations.reload();

    expect(result.reloaded).toBe(false);
    expect(result.reason).toContain('could not parse YAML');
    // The endpoint is still serving what it was serving, and the runtimes
    // behind it are still open. A config caught mid-write must not be able to
    // take an endpoint down.
    expect(result.epoch).toBe(0);
    expect(generations.current.names()).toEqual(['before']);
    expect(before.closes).toBe(0);
  });

  test('two concurrent reloads open one workspace, not two', async () => {
    let opened = 0;
    const generations = generationsOver(stub('before'), async () => {
      opened += 1;
      await Promise.resolve();
      return stub('after');
    });

    const [first, second] = await Promise.all([generations.reload(), generations.reload()]);

    expect(opened).toBe(1);
    expect(first).toEqual(second);
  });
});

describe('a pinned generation', () => {
  test('is not closed while a request still holds it', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () => Promise.resolve(stub('after')));

    const held = generations.acquire();
    await generations.reload();

    // Replaced, so nothing new reaches it — but the request that started
    // against it is still using its connectors and its audit log.
    expect(generations.current.names()).toEqual(['after']);
    expect(before.closes).toBe(0);

    await generations.release(held);
    expect(before.closes).toBe(1);
  });

  test('serves the request that started on it, not the one that replaced it', async () => {
    const generations = generationsOver(stub('before'), () => Promise.resolve(stub('after')));

    const held = generations.acquire();
    await generations.reload();

    expect(held.names()).toEqual(['before']);
    expect(generations.current.names()).toEqual(['after']);

    await generations.release(held);
  });

  test('closes once, however many requests were holding it', async () => {
    const before = stub('before');
    const generations = generationsOver(before, () => Promise.resolve(stub('after')));

    const first = generations.acquire();
    const second = generations.acquire();
    await generations.reload();

    await generations.release(first);
    expect(before.closes).toBe(0);

    await generations.release(second);
    expect(before.closes).toBe(1);

    // A late release must not close it a second time — closing a runtime twice
    // is an error that surfaces long after the work succeeded.
    await generations.release(second);
    expect(before.closes).toBe(1);
  });
});
