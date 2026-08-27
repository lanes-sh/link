import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { isResourceListResult, isResourceResult, isToolResult } from '#connectivity';
import { assetsProvider } from './provider.ts';
import { isTextual } from './store.ts';
import { harnessFor, linksOf, textOf } from '../harness.ts';

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
    expect(linksOf(stored)).toEqual(['assets://file/notes.txt']);
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
      /cannot resolve/,
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
    expect(textOf(await harness.invoke('file', { uri: 'assets://file/notes.txt' }))).toBe('hello');
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
    expect(read).toContain('lanes link attach');
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
    expect(isResourceResult(await harness.invoke('file', { uri: 'assets://file/notes.txt' }))).toBe(
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
    expect(write?.capabilities.sort()).toEqual(['remove', 'store']);
  });
});
