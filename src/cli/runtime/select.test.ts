import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '#profile';
import { openBlobStoreFor } from './select.ts';

/**
 * Opening one target's stores, without opening a runtime.
 *
 * `openSecretStoreFor` exists because two callers need exactly this much and a
 * full runtime would fail on the part neither uses. Removal is the third, and
 * it needs the blob store for the same reason: it enumerates a target's objects
 * and never dispatches a call.
 */

const config = (): Config =>
  ({
    contract: 1,
    instance: { profile: 'personal', default_target: 'local' },
    targets: {
      local: {
        credentials: { adapter: 'file' },
        storage: { adapter: 'filesystem' },
      },
    },
    connections: [],
    policy: { allow: [] },
  }) as unknown as Config;

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'lanes-link-select-'));
}

describe('openBlobStoreFor', () => {
  test('opens the target storage, rooted where the layout says', async () => {
    const root = await workspace();

    const store = await openBlobStoreFor(config(), root, 'local');
    await store.put('note.txt', new TextEncoder().encode('x'));

    expect((await store.list()).map((blob) => blob.key)).toContain('note.txt');
  });

  test('an area reaches a root other than the profile’s own', async () => {
    // `profiles` is where a deployed revision reads its config from (ADR-023),
    // and it is outside the profile's blob tree — so removing the remote copy
    // needs a store that is not rooted at `data/<profile>`.
    const root = await workspace();

    const own = await openBlobStoreFor(config(), root, 'local');
    const elsewhere = await openBlobStoreFor(config(), root, 'local', 'profiles');

    await own.put('a.txt', new TextEncoder().encode('x'));

    expect((await elsewhere.list()).map((blob) => blob.key)).not.toContain('a.txt');
  });

  test('refuses a target the profile does not declare', async () => {
    const root = await workspace();

    await expect(openBlobStoreFor(config(), root, 'cloud')).rejects.toThrow(/cloud/);
  });
});
