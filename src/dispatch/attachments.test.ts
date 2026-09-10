import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { scopeBlobStore } from '#stores/blobs';
import type { GrantConfig } from '#profile';
import { PROFILE_HANDLE, STAGED_TTL_MS } from '#connectivity/mail';
import { createAttachmentBridge } from './attachments.ts';

/**
 * The bridge is the one place a file crosses from one connection's world into
 * the profile's. Everything here is either "the crossing works" or "the crossing
 * cannot be turned into something it should not reach".
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const grant = (connection: string): GrantConfig => ({
  connection,
  allow: [{ capability: `${connection.split('.')[0]}.*` }],
  deny: [],
});

const bridgeOver = (
  storage: ReturnType<typeof createMemoryBlobStore>,
  options: { grants?: readonly GrantConfig[]; allows?: boolean } = {},
) =>
  createAttachmentBridge({
    storage,
    grants: options.grants ?? [grant('lanes_assets.lan3')],
    allows: () => options.allows ?? true,
  });

describe('staging a file for the whole profile', () => {
  test('the bytes land in the profile area, under a stg_ handle', async () => {
    const storage = createMemoryBlobStore();
    const bridge = bridgeOver(storage);

    const receipt = await bridge.stage({
      bytes: PDF,
      filename: 'draft.pdf',
      contentType: 'application/pdf',
    });

    expect(receipt.handle.startsWith(PROFILE_HANDLE)).toBe(true);
    expect(await storage.get(`attachments.d/attachments/${receipt.handle}`)).toEqual(PDF);
    expect(receipt.expiresAt).toBeGreaterThan(Date.now());
    expect(receipt.expiresAt).toBeLessThanOrEqual(Date.now() + STAGED_TTL_MS);
  });

  test('what was staged reads back with the name and type it was given', async () => {
    const storage = createMemoryBlobStore();
    const bridge = bridgeOver(storage);

    const { handle } = await bridge.stage({
      bytes: PDF,
      filename: 'draft.pdf',
      contentType: 'application/pdf',
    });
    const found = await bridge.staged!(handle);

    expect(found?.bytes).toEqual(PDF);
    expect(found?.filename).toBe('draft.pdf');
    expect(found?.contentType).toBe('application/pdf');
  });

  test('an expired handle is swept by the next stage, not left to accumulate', async () => {
    const storage = createMemoryBlobStore();
    const area = scopeBlobStore(storage, 'attachments.d');
    await area.put('attachments/stg_old', PDF);
    await area.put(
      'attachments/stg_old.json',
      new TextEncoder().encode(JSON.stringify({ expires_at: Date.now() - 1000 })),
    );

    await bridgeOver(storage).stage({ bytes: PDF, filename: 'a.pdf', contentType: 'text/plain' });

    expect(await area.get('attachments/stg_old')).toBeNull();
  });

  test('a handle staged in one profile does not resolve in another', async () => {
    const root = createMemoryBlobStore();
    const a = bridgeOver(scopeBlobStore(root, 'profiles/personal'));
    const b = bridgeOver(scopeBlobStore(root, 'profiles/work'));

    const { handle } = await a.stage({ bytes: PDF, filename: 'a.pdf', contentType: 'text/plain' });

    expect(await a.staged!(handle)).not.toBeNull();
    expect(await b.staged!(handle)).toBeNull();
  });
});

describe('reaching a file this profile keeps', () => {
  const withAsset = async (connectionId: string, name: string) => {
    const storage = createMemoryBlobStore();
    await scopeBlobStore(storage, `lanes_assets/${connectionId}`).put(name, PDF);
    return storage;
  };

  test('finds the one granted assets connection, whatever it is called', async () => {
    const storage = await withAsset('lan3', 'invoice.pdf');
    const bridge = bridgeOver(storage);

    expect((await bridge.asset!('invoice.pdf'))?.bytes).toEqual(PDF);
  });

  test('a name the store does not hold reads as absent, not as an error', async () => {
    const storage = await withAsset('lan3', 'invoice.pdf');

    expect(await bridgeOver(storage).asset!('gone.pdf')).toBeNull();
  });

  test('two granted assets connections are ambiguous, and it refuses rather than picking', async () => {
    const storage = await withAsset('lan3', 'invoice.pdf');
    const bridge = bridgeOver(storage, {
      grants: [grant('lanes_assets.lan3'), grant('lanes_assets.side')],
    });

    await expect(bridge.asset!('invoice.pdf')).rejects.toThrow(/lan3, side/);
  });

  test('a profile granting no assets connection says so', async () => {
    const bridge = bridgeOver(createMemoryBlobStore(), { grants: [grant('gmail.con1')] });

    await expect(bridge.asset!('invoice.pdf')).rejects.toThrow(/keeps no files/);
  });

  test('a caller denied the assets store cannot read it through an attachment', async () => {
    const storage = await withAsset('lan3', 'invoice.pdf');
    const bridge = bridgeOver(storage, { allows: false });

    await expect(bridge.asset!('invoice.pdf')).rejects.toThrow(/not permitted to read/);
  });
});
