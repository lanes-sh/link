import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { isResourceListResult, isResourceResult, isToolResult } from '#connectivity';
import { assetsProvider } from './provider.ts';
import { assetStorage, isTextual } from './store.ts';
import { harnessFor, linksOf, textOf } from '../harness.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';

/**
 * Assets.
 *
 * Two properties, and they are the two reasons this provider exists rather than
 * a wider memory:
 *
 *   - **Bytes do not pass through the model in either direction.** A write names
 *     a source and the endpoint reads it; a read returns text or a description,
 *     never base64.
 *   - **The key is the filename**, so there is no sidecar and no index — the
 *     listing is `list()` and nothing else.
 */

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((one) => rm(one, { recursive: true, force: true })));
});

function assets() {
  return harnessFor(assetsProvider);
}

/** A real file on disk, since `path` is the source that reads one. */
async function fileWith(name: string, contents: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lanes-link-assets-'));
  directories.push(directory);

  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

describe('storing a file names a source rather than carrying it', () => {
  test('a path is read by the endpoint, and the name comes from the file', async () => {
    const harness = assets();
    const path = await fileWith('notes.txt', 'the contents');

    const stored = await harness.invoke('store', { source: { path } });

    expect(isToolResult(stored) && stored.isError).toBeFalsy();
    expect(linksOf(stored)).toEqual(['lanes-assets://file/notes.txt']);
    expect((await harness.context.storage.list()).map((blob) => blob.key)).toEqual(['notes.txt']);
  });

  test('a name may be given instead, and improves the type where the source had none', async () => {
    const harness = assets();
    const path = await fileWith('download', 'a,b,c\n1,2,3\n');

    await harness.invoke('store', { source: { path }, name: 'report.csv' });

    expect(textOf(await harness.invoke('list'))).toContain('text/csv');
  });

  test('naming two sources is refused rather than resolved', async () => {
    const harness = assets();
    const path = await fileWith('notes.txt', 'x');

    expect(
      harness.invoke('store', { source: { path, url: 'https://example.com/notes.txt' } }),
    ).rejects.toThrow(/names 2 sources/);
  });

  test('naming none is refused, and says what the sources are', async () => {
    const harness = assets();

    expect(harness.invoke('store', { source: {} })).rejects.toThrow(/names no file/);
  });

  test('message_id is refused here, because this connection is not a mailbox', async () => {
    const harness = assets();

    expect(harness.invoke('store', { source: { message_id: '18f' } })).rejects.toThrow(
      /only a mail connection can resolve/,
    );
  });

  test('the resolved facts reach the audit log, and the bytes do not', async () => {
    const harness = assets();
    const path = await fileWith('secret.txt', 'the confidential contents');

    await harness.invoke('store', { source: { path } });

    const annotations = harness.annotations();
    expect(annotations).toMatchObject({ asset: 'secret.txt', replaced: false, bytes: 25 });
    expect(annotations['sha256']).toBeString();
    expect(annotations['origin']).toContain('secret.txt');
    expect(JSON.stringify(annotations)).not.toContain('confidential');
  });

  test('storing under a name that exists replaces it', async () => {
    const harness = assets();
    await harness.invoke('store', { source: { path: await fileWith('a.txt', 'first') } });
    const again = await harness.invoke('store', {
      source: { path: await fileWith('a.txt', 'second') },
    });

    expect(textOf(again)).toContain('Replaced');
    expect(textOf(await harness.invoke('get', { name: 'a.txt' }))).toBe('second');
    expect((await harness.context.storage.list()).map((blob) => blob.key)).toEqual(['a.txt']);
  });
});

describe('reading returns text, or a description — never base64', () => {
  test('a text file comes back as its contents', async () => {
    const harness = assets();
    await harness.invoke('store', { source: { path: await fileWith('notes.txt', 'hello') } });

    expect(textOf(await harness.invoke('get', { name: 'notes.txt' }))).toBe('hello');
    expect(textOf(await harness.invoke('file', { uri: 'lanes-assets://file/notes.txt' }))).toBe('hello');
  });

  test('a binary file is described, with its digest, and its bytes are not returned', async () => {
    const harness = assets();
    // A PNG header: a real content type, and a NUL in the first eight bytes.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await harness.invoke('store', { source: { path: await fileWith('shot.png', png) } });

    const read = textOf(await harness.invoke('get', { name: 'shot.png' }));

    expect(read).toContain('image/png');
    expect(read).toContain('sha256');
    expect(read).toContain('not text');
    // What a description of a binary asset is *for*: the next call. Naming it
    // as an asset is something the model can do, where the CLI it used to point
    // at is the owner's to run.
    expect(read).toContain('{ "asset": "<name>" }');
    expect(read).not.toContain('iVBOR');
  });

  test('a mislabelled binary is still caught, because the bytes are checked too', async () => {
    // The type says text and the bytes disagree. The type is a claim.
    expect(isTextual('text/plain', new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
    expect(isTextual('text/plain', new Uint8Array([0x68, 0x69]))).toBe(true);
    expect(isTextual('application/json', new TextEncoder().encode('{}'))).toBe(true);
    expect(isTextual('application/pdf', new TextEncoder().encode('%PDF'))).toBe(false);
  });

  test('reading something that is not there is an error', async () => {
    const harness = assets();
    const result = await harness.invoke('get', { name: 'nope.txt' });

    expect(isToolResult(result) && result.isError).toBe(true);
  });
});

describe('the key is the filename, so the listing is the whole index', () => {
  test('nothing is stored but the file itself — no sidecar, no index', async () => {
    const harness = assets();
    await harness.invoke('store', { source: { path: await fileWith('invoice.pdf', '%PDF-1.4') } });

    expect((await harness.context.storage.list()).map((blob) => blob.key)).toEqual([
      'invoice.pdf',
    ]);
  });

  test('a listing reports name, type and size', async () => {
    const harness = assets();
    await harness.invoke('store', { source: { path: await fileWith('notes.txt', 'x'.repeat(2048)) } });

    const listed = textOf(await harness.invoke('list'));
    expect(listed).toContain('notes.txt');
    expect(listed).toContain('text/plain');
    expect(listed).toContain('2 KB');
  });

  test('assets are addressable as resources', async () => {
    const harness = assets();
    await harness.invoke('store', { source: { path: await fileWith('notes.txt', 'x') } });

    const listed = await harness.invoke('file');
    expect(isResourceListResult(listed) && listed.resources).toHaveLength(1);
    expect(isResourceResult(await harness.invoke('file', { uri: 'lanes-assets://file/notes.txt' }))).toBe(
      true,
    );
  });

  test('a name with a path separator is refused, so the set stays flat', async () => {
    const harness = assets();
    const path = await fileWith('notes.txt', 'x');

    expect(
      harness.invoke('store', { source: { path }, name: 'sub/notes.txt' }),
    ).rejects.toThrow(/path separator/);
  });

  test('a dotfile is refused, because it would be invisible in the directory', async () => {
    const harness = assets();
    const path = await fileWith('notes.txt', 'x');

    expect(harness.invoke('store', { source: { path }, name: '.hidden' })).rejects.toThrow(
      /must not start with a dot/,
    );
  });
});

describe('deleting', () => {
  test('removing takes the bytes with it', async () => {
    const harness = assets();
    await harness.invoke('store', { source: { path: await fileWith('a.txt', 'x') } });

    await harness.invoke('remove', { name: 'a.txt' });

    expect(await harness.context.storage.list()).toEqual([]);
  });

  test('removing something absent is an error rather than a silent success', async () => {
    const harness = assets();
    const result = await harness.invoke('remove', { name: 'nope.txt' });

    expect(isToolResult(result) && result.isError).toBe(true);
  });
});

describe('reading and writing are different capabilities', () => {
  test('the default bundle reads and does not write', () => {
    const bundles = assetsProvider.manifest.bundles ?? [];
    const read = bundles.find((bundle) => bundle.default);

    expect(read?.name).toBe('read');
    expect(read?.capabilities).toEqual(['file', 'list', 'get']);
  });

  test('every write is in the non-default bundle', () => {
    const bundles = assetsProvider.manifest.bundles ?? [];
    const write = bundles.find((bundle) => bundle.name === 'write');

    expect(write?.default).toBeFalsy();
    expect(write?.capabilities.sort()).toEqual(['remove', 'stage', 'store']);
  });
});

describe('a store that does not know the type', () => {
  test('an octet-stream from the store is re-read from the extension', async () => {
    // What a bucket hands back for a file uploaded without a content type, and
    // the reason a markdown asset on a deployed workspace was described instead
    // of returned. `??` never fired, because the store did give a value: it
    // just was not a claim about the bytes.
    const storage = createMemoryBlobStore();
    await storage.put('notes.md', new TextEncoder().encode('# Notes\n'), {
      contentType: 'application/octet-stream',
    });

    const asset = await assetStorage.find(storage, 'notes.md');
    expect(asset?.contentType).toBe('text/markdown');
    expect(assetStorage.isTextual(asset!.contentType, new TextEncoder().encode('# Notes\n'))).toBe(
      true,
    );
  });

  test('a real declaration is still believed over the extension', async () => {
    const storage = createMemoryBlobStore();
    await storage.put('report.md', new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      contentType: 'application/pdf',
    });

    // The store knows something the name does not, and it wins.
    expect((await assetStorage.find(storage, 'report.md'))?.contentType).toBe('application/pdf');
  });

  test('an extension nobody recognises lands where it started', async () => {
    const storage = createMemoryBlobStore();
    await storage.put('thing.qqq', new Uint8Array([1, 2, 3]), {
      contentType: 'application/octet-stream',
    });

    // Re-guessing is free here: `guessContentType` falls back to the same value.
    expect((await assetStorage.find(storage, 'thing.qqq'))?.contentType).toBe(
      'application/octet-stream',
    );
  });
});

// SHA-256 of "hello", asserted against an independent value rather than against
// whatever the code happens to produce: `printf 'hello' | shasum -a 256`.
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

describe('holding a file for a later call', () => {
  /**
   * The gap this closes. A client holding a file only it can see — a chat
   * runtime's own sandbox — had no way to hand it over: `path` names the
   * endpoint's disk, `url` must be fetchable, and a handle needed a stage that
   * only the HTTP route and the CLI could do. `data` was the one channel MCP
   * offers, and every description around it said not to use it.
   */
  const staging = () => {
    const staged = new Map<string, { bytes: Uint8Array; filename: string; contentType: string }>();
    return {
      staged,
      harness: harnessFor(assetsProvider, 'owner', {
        attachments: {
          stage: async (input: { bytes: Uint8Array; filename: string; contentType: string }) => {
            const handle = `stg_${staged.size}`;
            staged.set(handle, input);
            return { handle, sha256: 'abc', expiresAt: 1_700_000_000_000 };
          },
          staged: async (handle: string) => {
            const found = staged.get(handle);
            return found
              ? { bytes: found.bytes, filename: found.filename, contentType: found.contentType }
              : null;
          },
          asset: async () => null,
        },
      }),
    };
  };

  test('a file only the caller has crosses once, and comes back as a handle', async () => {
    const { staged, harness } = staging();

    const result = await harness.invoke('stage', {
      source: { data: Buffer.from('hello').toString('base64') },
      filename: 'draft.txt',
    });

    const body = JSON.parse(textOf(result));
    expect(body['handle']).toBe('stg_0');
    expect(body['bytes']).toBe(5);
    expect(body['filename']).toBe('draft.txt');
    expect(staged.get('stg_0')?.bytes).toEqual(new Uint8Array(Buffer.from('hello')));
  });

  test('the receipt carries a digest and an expiry, and never the bytes', async () => {
    const { harness } = staging();
    const base64 = Buffer.from('hello').toString('base64');

    const result = await harness.invoke('stage', {
      source: { data: base64 },
      filename: 'draft.txt',
    });

    const text = textOf(result);
    expect(JSON.parse(text)['sha256']).toBe(HELLO_SHA256);
    expect(JSON.parse(text)['expires_at']).toBe('2023-11-14T22:13:20.000Z');
    // The whole point of the provider: what comes back names the file, it is
    // not the file.
    expect(text).not.toContain(base64);
    expect(text).not.toContain('hello');
  });

  test('what it stages, a send can name', async () => {
    const { harness } = staging();

    const staging_result = await harness.invoke('stage', {
      source: { data: Buffer.from('hello').toString('base64') },
      filename: 'draft.txt',
    });
    const handle = JSON.parse(textOf(staging_result))['handle'] as string;

    // Stored through the same handle, which is what a mail send does too.
    const stored = await harness.invoke('store', { source: { handle }, name: 'draft.txt' });

    expect(textOf(stored)).toContain('draft.txt');
  });

  test('the audit record says what entered the endpoint, and where from', async () => {
    const { harness } = staging();

    await harness.invoke('stage', {
      source: { data: Buffer.from('hello').toString('base64') },
      filename: 'draft.txt',
    });

    expect(harness.annotations()).toMatchObject({
      handle: 'stg_0',
      filename: 'draft.txt',
      bytes: 5,
      sha256: HELLO_SHA256,
      origin: 'inline',
    });
  });

  test('the name given here decides the type, as it does when storing', async () => {
    // Found against a live endpoint, not by a test: `filename` is a sibling of
    // `source`, so the resolver never saw it and guessed the type from nothing.
    // A .txt arriving as application/octet-stream is a file that downloads
    // instead of opening.
    const { staged, harness } = staging();

    const result = await harness.invoke('stage', {
      source: { data: Buffer.from('hello').toString('base64') },
      filename: 'draft.txt',
    });

    expect(JSON.parse(textOf(result))['content_type']).toBe('text/plain');
    expect(staged.get('stg_0')?.contentType).toBe('text/plain');
  });

  test('an explicit content_type still wins over the name', async () => {
    const { harness } = staging();

    const result = await harness.invoke('stage', {
      source: { data: Buffer.from('hello').toString('base64') },
      filename: 'draft.txt',
      content_type: 'text/markdown',
    });

    expect(JSON.parse(textOf(result))['content_type']).toBe('text/markdown');
  });

  test('an endpoint with no staging area refuses legibly rather than throwing', async () => {
    const result = await harnessFor(assetsProvider).invoke('stage', {
      source: { data: Buffer.from('hello').toString('base64') },
      filename: 'draft.txt',
    });

    expect(textOf(result)).toMatch(/cannot hold a file/);
  });
});
