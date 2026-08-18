import { describe, expect, test } from 'bun:test';
import { scopeBlobStore, type BlobMetadata, type BlobStore } from './index.ts';

function memoryBlobStore(): BlobStore & { raw: Map<string, Uint8Array> } {
  const raw = new Map<string, Uint8Array>();
  return {
    raw,
    async put(key, data) {
      raw.set(key, data);
    },
    async get(key) {
      return raw.get(key) ?? null;
    },
    async has(key) {
      return raw.has(key);
    },
    async delete(key) {
      raw.delete(key);
    },
    async list(prefix) {
      const out: BlobMetadata[] = [];
      for (const [key, value] of raw) {
        if (!prefix || key.startsWith(prefix)) {
          out.push({ key, size: value.byteLength, modifiedAt: new Date(0) });
        }
      }
      return out;
    },
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('blob namespacing', () => {
  test('writes land under the namespace', async () => {
    const base = memoryBlobStore();
    const scoped = scopeBlobStore(base, 'example/a');

    await scoped.put('note.txt', bytes('hello'));

    expect([...base.raw.keys()]).toEqual(['example/a/note.txt']);
    expect(await scoped.get('note.txt')).toEqual(bytes('hello'));
  });

  test('one connection cannot read another connection of the same provider', async () => {
    const base = memoryBlobStore();
    const a = scopeBlobStore(base, 'example/a');
    const b = scopeBlobStore(base, 'example/b');

    await a.put('note.txt', bytes('from a'));

    expect(await b.get('note.txt')).toBeNull();
    expect(await b.has('note.txt')).toBe(false);
  });

  test('listing is namespace-relative and does not leak other keys', async () => {
    const base = memoryBlobStore();
    const a = scopeBlobStore(base, 'example/a');
    const b = scopeBlobStore(base, 'example/b');

    await a.put('one.txt', bytes('1'));
    await a.put('two.txt', bytes('2'));
    await b.put('secret.txt', bytes('3'));

    const listed = (await a.list()).map((entry) => entry.key).sort();
    expect(listed).toEqual(['one.txt', 'two.txt']);
  });

  test('delete cannot reach outside the namespace', async () => {
    const base = memoryBlobStore();
    const a = scopeBlobStore(base, 'example/a');
    const b = scopeBlobStore(base, 'example/b');

    await b.put('note.txt', bytes('b owns this'));
    await a.delete('note.txt'); // deletes example/a/note.txt, which does not exist

    expect(await b.get('note.txt')).toEqual(bytes('b owns this'));
  });
});

describe('key traversal is a boundary, not a sanitisation', () => {
  const scoped = scopeBlobStore(memoryBlobStore(), 'example/a');

  test('rejects parent traversal rather than silently rewriting it', async () => {
    // Rewriting would hide a provider bug; throwing surfaces it.
    await expect(scoped.get('../b/note.txt')).rejects.toThrow(/traverse/);
    await expect(scoped.put('../../etc/passwd', bytes('x'))).rejects.toThrow(/traverse/);
    await expect(scoped.delete('a/../../b/note.txt')).rejects.toThrow(/traverse/);
  });

  test('rejects absolute paths and NUL bytes', async () => {
    await expect(scoped.get('/etc/passwd')).rejects.toThrow(/relative/);
    await expect(scoped.get('note\0.txt')).rejects.toThrow(/NUL/);
  });

  test('rejects an empty key', async () => {
    await expect(scoped.get('')).rejects.toThrow(/must not be empty/);
  });

  test('allows a literal double-dot inside a filename', async () => {
    // `..` is only a traversal when it is a whole path segment.
    const base = memoryBlobStore();
    const store = scopeBlobStore(base, 'example/a');
    await store.put('archive..2026.txt', bytes('fine'));
    expect([...base.raw.keys()]).toEqual(['example/a/archive..2026.txt']);
  });
});
