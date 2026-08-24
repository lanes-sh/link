import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBlobStoreContract, type ContractBlobStore } from '#stores/blobs/conformance.ts';
import { createFilesystemBlobStore } from './filesystem.ts';

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lanes-link-blob-'));
  roots.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(roots.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function filesystemStore(): Promise<ContractBlobStore> {
  const directory = await root();
  return {
    open: () => createFilesystemBlobStore({ root: directory }),
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describeBlobStoreContract('filesystem', filesystemStore);

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

/**
 * What is left here is filesystem mechanism, not `BlobStore` behaviour: the
 * sidecar files this adapter invented to carry a content type, its
 * write-then-rename, and a root that does not exist yet. An S3 bucket has no
 * equivalent of any of them.
 */

describe('filesystem: sidecar files', () => {
  test('hides sidecar and temporary files from the key space', async () => {
    const directory = await root();
    const store = createFilesystemBlobStore({ root: directory });

    await store.put('doc.txt', bytes('x'), { contentType: 'text/plain' });
    await writeFile(join(directory, 'stray.tmp'), 'leftover');

    expect((await store.list()).map((entry) => entry.key)).toEqual(['doc.txt']);
    expect((await store.list())[0]?.contentType).toBe('text/plain');
  });

  test('deleting a blob takes its sidecar with it', async () => {
    const directory = await root();
    const store = createFilesystemBlobStore({ root: directory });

    await store.put('doc.txt', bytes('x'), { contentType: 'text/plain' });
    await store.delete('doc.txt');

    expect(await readdir(directory)).toEqual([]);
  });
});

describe('filesystem: durability', () => {
  test('leaves no temporary file behind', async () => {
    const directory = await root();
    const store = createFilesystemBlobStore({ root: directory });

    await store.put('one.txt', bytes('1'));
    await store.put('one.txt', bytes('overwritten'));

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(read(await store.get('one.txt'))).toBe('overwritten');
  });
});

describe('filesystem: root directory', () => {
  test('listing a root that was never created returns nothing rather than throwing', async () => {
    const store = createFilesystemBlobStore({ root: join(await root(), 'not-created-yet') });
    expect(await store.list()).toEqual([]);
  });

  test('creates intermediate directories on write', async () => {
    const directory = await root();
    const store = createFilesystemBlobStore({ root: directory });

    await store.put('a/b/c/deep.txt', bytes('deep'));
    expect(await readdir(join(directory, 'a', 'b', 'c'))).toEqual(['deep.txt']);
  });
});

describe('what the bytes are readable by', () => {
  // The credential store and the vault are 0600 already. This store holds
  // everything else a profile owns — the audit log, `state.kv`, memory entries
  // and cached mail attachments — and it was writing all of it at the umask
  // default, so on a shared machine any local user could read it.
  test('a blob and its directory are the owner\'s alone', async () => {
    const directory = await root();
    const store = createFilesystemBlobStore({ root: directory });

    await store.put('nested/secret.txt' as never, new TextEncoder().encode('private'));

    const blob = await stat(join(directory, 'nested/secret.txt'));
    const parent = await stat(join(directory, 'nested'));

    expect(blob.mode & 0o777).toBe(0o600);
    expect(parent.mode & 0o777).toBe(0o700);
  });

  test('the mode is set at creation, not chmoded after the write', async () => {
    // A chmod afterwards leaves a window where the bytes exist and are world
    // readable, which is the failure mode this is guarding against.
    const directory = await root();
    const store = createFilesystemBlobStore({ root: directory });

    await store.put('a.md' as never, new TextEncoder().encode('# hi'), {
      contentType: 'text/plain',
    });

    // The sidecar too — it lands beside the blob and took the same default.
    expect((await stat(join(directory, 'a.md'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'a.md.meta'))).mode & 0o777).toBe(0o600);
  });
});

describe('deleting the last object under a prefix', () => {
  test('leaves no empty directory behind', async () => {
    // An object store has no directories: `a/b/c.txt` is one flat key, and
    // removing it leaves nothing called `a/b`. This adapter emulates that
    // interface, so an empty directory surviving a delete is a filesystem
    // artifact leaking through — visible as a `data/<profile>` that outlives
    // the profile whose objects it held.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-fs-'));
    const store = createFilesystemBlobStore({ root });

    await store.put('deep/nested/thing.txt', new TextEncoder().encode('x'));
    await store.delete('deep/nested/thing.txt');

    expect(existsSync(join(root, 'deep/nested'))).toBe(false);
    expect(existsSync(join(root, 'deep'))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  test('keeps a directory that still holds something', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-fs-'));
    const store = createFilesystemBlobStore({ root });

    await store.put('shared/gone.txt', new TextEncoder().encode('x'));
    await store.put('shared/stays.txt', new TextEncoder().encode('y'));
    await store.delete('shared/gone.txt');

    expect(existsSync(join(root, 'shared/stays.txt'))).toBe(true);
  });
});
