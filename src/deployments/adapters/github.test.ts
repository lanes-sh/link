import { describe, expect, test } from 'bun:test';
import { describeBlobStoreContract } from '#stores/blobs/conformance.ts';
import { createGithubBlobStore } from './github.ts';
import { GithubRepository } from './github-repo.ts';
import { commitFiles } from './github-commit.ts';
import { createFakeGithub, type FakeGithubOptions } from './github-testing.ts';

/**
 * The adapter, held to the one `BlobStore` contract every other adapter is.
 *
 * That is the whole point of `conformance.ts`: `docs/detailed/init.md` promises
 * no application-layer code differs between targets, and the promise is only
 * worth something if the adapters behave identically. A key the filesystem
 * refuses must not be one a repository accepts.
 */

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

function build(options: FakeGithubOptions = {}, root?: string) {
  const github = createFakeGithub(options);
  const repository = new GithubRepository({
    repo: options.repo ?? 'my-org/my-notes',
    token: 'github_pat_stub',
    fetch: github.fetch,
    // Every read revalidates, so the tests exercise the conditional request
    // rather than a window in which staleness happens not to matter.
    freshnessMs: 0,
  });
  return {
    github,
    repository,
    store: createGithubBlobStore({ repository, ...(root ? { root } : {}) }),
  };
}

describeBlobStoreContract('github', async () => {
  const { store } = build();
  return { open: () => store, dispose: async () => {} };
});

describeBlobStoreContract('github (under a path prefix)', async () => {
  const { store } = build({}, 'context/memory');
  return { open: () => store, dispose: async () => {} };
});

describe('github blob store', () => {
  test('an empty repository reads as empty rather than failing', async () => {
    const { store } = build();

    expect(await store.list()).toEqual([]);
    expect(await store.get('note.md')).toBeNull();
    expect(await store.has('note.md')).toBe(false);
  });

  test('the first write to an empty repository creates the branch', async () => {
    const { github, store } = build();

    await store.put('note.md', bytes('first'));

    expect(github.files()).toEqual({ 'note.md': 'first' });
    expect(decode(await store.get('note.md'))).toBe('first');
  });

  test('a root keeps keys out of the paths and paths out of the keys', async () => {
    const { github, store } = build({}, 'context/memory');

    await store.put('main/note.md', bytes('scoped'));

    expect(Object.keys(github.files())).toEqual(['context/memory/main/note.md']);
    expect((await store.list()).map((entry) => entry.key)).toEqual(['main/note.md']);
  });

  test('a listing ignores everything outside its root', async () => {
    const { store } = build(
      { files: { 'memory/main/a.md': 'a', 'skills/triage/SKILL.md': 's', 'README.md': 'r' } },
      'memory',
    );

    expect((await store.list()).map((entry) => entry.key)).toEqual(['main/a.md']);
  });

  test('every write is a commit, and says what it did', async () => {
    const { github, store } = build();

    await store.put('note.md', bytes('one'));
    await store.put('note.md', bytes('two'));
    await store.delete('note.md');

    expect(github.commitCount()).toBe(3);
  });

  test('a file changed by somebody else is seen on the next read', async () => {
    // The property the API buys over a clone: an entry edited on github.com,
    // or written by a deployed endpoint, needs no pull.
    const { github, store } = build({ files: { 'note.md': 'ours' } });

    expect(decode(await store.get('note.md'))).toBe('ours');
    github.writeBehind('note.md', 'theirs');
    expect(decode(await store.get('note.md'))).toBe('theirs');
  });

  test('content type comes from the extension, which covers what is stored here', async () => {
    const { store } = build();

    await store.put('entry.md', bytes('# markdown'));
    expect((await store.list())[0]?.contentType).toBe('text/markdown');
  });

  test('modifiedAt is the branch tip, so a fingerprint changes when the tree does', async () => {
    const { store } = build({ files: { 'a.md': 'a' } });

    const before = (await store.list())[0]?.modifiedAt;
    expect(before?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('the repository client', () => {
  test('an unchanged branch is revalidated for free, and the tree is not refetched', async () => {
    const { github, repository } = build({ files: { 'a.md': 'a' } });

    await repository.entries();
    const afterFirst = github.calls.length;
    await repository.entries();

    // One conditional branch read, answered 304 — and no second tree request,
    // because the tree is keyed by a commit sha that did not move.
    expect(github.calls.slice(afterFirst)).toEqual(['GET /repos/my-org/my-notes/branches/main']);
  });

  test('a blob is fetched once and then served from its sha', async () => {
    const { github, repository } = build({ files: { 'a.md': 'a' } });

    const { entries } = await repository.entries();
    const sha = entries.get('a.md')!.sha;

    await repository.blob(sha);
    const afterFirst = github.calls.length;
    await repository.blob(sha);

    expect(github.calls.length).toBe(afterFirst);
  });

  test('a write that lost a race is retried against the current sha', async () => {
    const { github, repository } = build({ files: { 'a.md': 'a' } });
    github.failNext('PUT /repos/my-org/my-notes/contents/a.md', new Response(null, { status: 409 }));

    await repository.writeFile('a.md', bytes('mine'), 'Store a.md');

    expect(github.files()['a.md']).toBe('mine');
  });

  test('a write that keeps losing says what is happening rather than looping', async () => {
    const { github, repository } = build({ files: { 'a.md': 'a' } });
    const conflict = () => new Response(null, { status: 409 });
    github.failNext('PUT /repos/my-org/my-notes/contents/a.md', conflict());
    github.failNext('PUT /repos/my-org/my-notes/contents/a.md', conflict());

    await expect(repository.writeFile('a.md', bytes('mine'), 'Store a.md')).rejects.toThrow(
      /changed while it was being written, twice/,
    );
  });

  test('a spent rate limit is reported as one, not as a generic 403', async () => {
    const { github, repository } = build({ files: { 'a.md': 'a' } });
    github.failNext(
      'GET /repos/my-org/my-notes/branches/main',
      new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
      }),
    );

    await expect(repository.entries()).rejects.toThrow(/rate limit is spent/);
  });

  test('an expired token says how to replace it', async () => {
    const { github, repository } = build();
    github.failNext('GET /user', new Response(null, { status: 401 }));

    await expect(repository.viewer()).rejects.toThrow(/lanes link knowledge use github/);
  });

  test('a truncated tree is refused rather than served short', async () => {
    const { github, repository } = build({ files: { 'a.md': 'a' } });
    github.failNext(
      'GET /repos/my-org/my-notes/git/trees/',
      new Response(JSON.stringify({ tree: [], truncated: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(repository.entries()).rejects.toThrow(/too large to list in one request/);
  });

  test('facts describe what the token may do here', async () => {
    const { repository } = build({ private: false, canPush: false });

    expect(await repository.facts()).toEqual({
      fullName: 'my-org/my-notes',
      private: false,
      defaultBranch: 'main',
      canPush: false,
      empty: true,
    });
  });
});

describe('committing many files at once', () => {
  test('a migration is one commit, whatever it moves', async () => {
    const { github, repository } = build();

    const sha = await commitFiles(
      repository,
      [
        { path: 'memory/main/a.md', data: bytes('a') },
        { path: 'memory/main/b.md', data: bytes('b') },
        { path: 'skills/triage/SKILL.md', data: bytes('s') },
      ],
      [],
      'Move memory and skills into this repository',
    );

    expect(sha).not.toBeNull();
    expect(github.files()).toEqual({
      'memory/main/a.md': 'a',
      'memory/main/b.md': 'b',
      'skills/triage/SKILL.md': 's',
    });
    // One commit for three files — not three.
    expect(github.calls.filter((call) => call.includes('/git/commits')).length).toBe(1);
  });

  test('into an empty repository, the ref is created rather than moved', async () => {
    const { github, repository } = build();

    await commitFiles(repository, [{ path: 'a.md', data: bytes('a') }], [], 'First');

    expect(github.calls).toContain('POST /repos/my-org/my-notes/git/refs');
    expect(github.calls).not.toContain('PATCH /repos/my-org/my-notes/git/refs/heads/main');
  });

  test('into a repository with history, what was there is kept', async () => {
    const { github, repository } = build({ files: { 'README.md': 'hello' } });

    await commitFiles(repository, [{ path: 'memory/main/a.md', data: bytes('a') }], [], 'Add');

    expect(github.files()).toEqual({ 'README.md': 'hello', 'memory/main/a.md': 'a' });
    expect(github.calls).toContain('PATCH /repos/my-org/my-notes/git/refs/heads/main');
  });

  test('deletions ride the same commit as the writes', async () => {
    const { github, repository } = build({ files: { 'old.md': 'old', 'keep.md': 'keep' } });

    await commitFiles(repository, [{ path: 'new.md', data: bytes('new') }], ['old.md'], 'Replace');

    expect(github.files()).toEqual({ 'keep.md': 'keep', 'new.md': 'new' });
  });

  test('nothing to commit makes no commit', async () => {
    const { github, repository } = build();

    expect(await commitFiles(repository, [], [], 'Nothing')).toBeNull();
    expect(github.calls).toEqual([]);
  });
});
