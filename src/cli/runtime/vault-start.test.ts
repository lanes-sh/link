import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '#profile';
import { readVaultItemsForStart } from './registry.ts';
import type { VaultStore } from '#secrets';

/**
 * What an unreadable vault does to the thing that opened it.
 *
 * Two callers with opposite needs. A command must not be taken down by a vault
 * it has no business with — `doctor` refused by the read it exists to explain
 * is the case that earned the tolerance. An endpoint must not serve past it,
 * because there is deliberately no `vault.list`: the per-item `vault.get.<id>`
 * tools are the whole agent-visible surface, so withholding them quietly serves
 * a vault that reads as empty rather than as broken.
 */

/** A vault whose listing fails the way a revoked grant does: not a ConfigError. */
function refusing(error: Error): VaultStore {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => false,
    ids: async () => {
      throw error;
    },
  };
}

describe('a vault that will not list', () => {
  test('is tolerated for a command, which says so and carries on', async () => {
    const warnings: string[] = [];

    const items = await readVaultItemsForStart(
      refusing(new Error('permission denied on vault/key')),
      true,
      (message) => warnings.push(message),
    );

    expect(items).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not open this profile');
    expect(warnings[0]).toContain('permission denied on vault/key');
  });

  test('refuses when it is not tolerated, carrying the original cause', async () => {
    await expect(
      readVaultItemsForStart(refusing(new Error('permission denied on vault/key')), false, () => {}),
    ).rejects.toThrow('permission denied on vault/key');
  });

  test('a ConfigError refuses either way, because that is a document this machine wrote', async () => {
    await expect(
      readVaultItemsForStart(refusing(new ConfigError('vault.enc is not valid')), true, () => {}),
    ).rejects.toThrow('vault.enc is not valid');
  });
});

describe('the endpoint opens its runtimes to serve', () => {
  test('so every openRuntime in the bootstrap says so', async () => {
    // Read off the source, as `selection.test.ts` reads the dispatch files: the
    // tolerance is decided by one flag, and a call that forgets it serves a
    // profile whose vault reads as empty with nothing failing to say so. A test
    // asserting behaviour through `openRuntime` would need a whole workspace
    // fixture to reach the one boolean this pins directly.
    const source = await readFile(join(import.meta.dir, '../../server/endpoint.ts'), 'utf8');
    const calls = source.match(/openRuntime\([\s\S]*?\);/g) ?? [];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('serving: true');
  });
});
