import { describe, expect, test } from 'bun:test';
import { workspaceVaultKey } from './derived.ts';

/**
 * The isolation property one process serving many workspaces rests on.
 *
 * ADR-070 says the vault's `keySource` is scoped per workspace. It was not:
 * `LANES_LINK_VAULT_KEY` was read once for the process, so every tenant's vault
 * was sealed under one key and any workspace that could reach another's
 * ciphertext could read it. The seam existed on both vault stores and nothing
 * had ever passed one.
 *
 * These are the assertions that make the fix worth having, and the ones to
 * check first if anybody changes how a key is derived.
 */

const MASTER = { LANES_LINK_VAULT_KEY: Buffer.alloc(32, 7).toString('base64') };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('a hosted workspace derives its own vault key', () => {
  test('two workspaces never derive the same key', async () => {
    // The whole point. If this ever passes trivially — both sides undefined,
    // both empty — the test has stopped testing anything, so the length is
    // asserted too.
    const mine = await workspaceVaultKey('ws-aaa', MASTER)();
    const theirs = await workspaceVaultKey('ws-bbb', MASTER)();

    expect(mine.length).toBe(32);
    expect(theirs.length).toBe(32);
    expect(hex(mine)).not.toBe(hex(theirs));
  });

  test('the same workspace derives the same key every time', async () => {
    // Not a nicety: a key that varied per call would make everything written
    // under the previous one permanently unreadable, which looks exactly like
    // working encryption until somebody tries to read it back.
    const once = await workspaceVaultKey('ws-aaa', MASTER)();
    const twice = await workspaceVaultKey('ws-aaa', MASTER)();

    expect(hex(once)).toBe(hex(twice));
  });

  test('neither is the master itself', async () => {
    const derived = await workspaceVaultKey('ws-aaa', MASTER)();
    const master = Buffer.from(MASTER.LANES_LINK_VAULT_KEY, 'base64');

    expect(hex(derived)).not.toBe(master.toString('hex'));
  });

  test('a different master gives a different key for the same workspace', async () => {
    const first = await workspaceVaultKey('ws-aaa', MASTER)();
    const second = await workspaceVaultKey('ws-aaa', {
      LANES_LINK_VAULT_KEY: Buffer.alloc(32, 9).toString('base64'),
    })();

    expect(hex(first)).not.toBe(hex(second));
  });

  test('takes the master as hex or base64, because the single-workspace path did', async () => {
    const base64 = await workspaceVaultKey('ws-aaa', MASTER)();
    const asHex = await workspaceVaultKey('ws-aaa', {
      LANES_LINK_VAULT_KEY: Buffer.alloc(32, 7).toString('hex'),
    })();

    expect(hex(base64)).toBe(hex(asHex));
  });

  test('says what is missing rather than deriving from nothing', async () => {
    await expect(workspaceVaultKey('ws-aaa', {})()).rejects.toThrow(
      /LANES_LINK_VAULT_KEY is required/,
    );
  });

  test('refuses a master too short to be one', async () => {
    await expect(
      workspaceVaultKey('ws-aaa', {
        LANES_LINK_VAULT_KEY: Buffer.alloc(8, 1).toString('base64'),
      })(),
    ).rejects.toThrow(/at least 32/);
  });
});

describe('which workspaces get one', () => {
  test('is the caller\'s decision, not this component\'s', () => {
    // `secrets` may not import `deployments` (`src/architecture.test.ts`), so
    // it cannot know that a hosted workspace is spelled `lanes://`. Anything
    // handed a workspace name derives a key; `cli/runtime/vault.ts` is where
    // the scheme is read and where a self-hosted deploy is decided to get none.
    expect(typeof workspaceVaultKey('ws-aaa', MASTER)).toBe('function');
  });
});
