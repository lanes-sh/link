import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsConnector } from './index.ts';
import type { ConnectorContext, DiscoveryContext, ToolResult } from '#connectivity';

/**
 * The `fs` connector, and mostly the one guard that matters.
 *
 * On a Mac with "Desktop & Documents" syncing, the configured root is very
 * nearly everything its owner has. `confine()` is the only thing between an
 * agent and the rest of the disk, so the escape attempts below are the point of
 * this file; the happy paths are almost incidental.
 */

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lanes-link-fs-'));
  outside = await mkdtemp(join(tmpdir(), 'lanes-link-outside-'));

  await writeFile(join(outside, 'private.txt'), 'the private thing');
  await mkdir(join(root, 'Notes'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'readme.md'), '# Hello\nA note about coffee.\n');
  await writeFile(join(root, 'Notes', 'plan.md'), 'Ship the thing.\n');
  await writeFile(join(root, '.git', 'config'), '[remote]\n  token = sk-secret\n');
  await writeFile(join(root, 'photo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  // The interesting one: a link inside the root pointing out of it.
  await symlink(outside, join(root, 'escape'));
  // And iCloud's eviction placeholder, standing in for a file not downloaded.
  await writeFile(join(root, '.evicted.pdf.icloud'), '<plist>metadata only</plist>');
});

afterAll(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});

// `placeholder` is declared by the provider — `icloud_drive` sets
// `.icloud`, because how a sync client marks an undownloaded file is Apple's
// convention rather than this transport's business.
const connector = () =>
  createFsConnector({
    root,
    maxFileBytes: 1024,
    exclude: [],
    placeholder: { suffix: '.icloud', hint: 'Open it once in Finder, or run: brctl download' },
  });

const invoke = (operation: string, args: Record<string, unknown>) =>
  connector().invoke(
    { name: operation, target: { operation } } as never,
    args,
    {} as unknown as ConnectorContext,
  );

/** The single text block a capability returns, as text or as the JSON in it. */
const textOf = (result: ToolResult): string =>
  (result.content[0] as { text?: string } | undefined)?.text ?? '';

const parsed = (result: ToolResult): Record<string, unknown> => JSON.parse(textOf(result));

describe('staying inside the root', () => {
  test.each([
    ['..'],
    ['../../etc/passwd'],
    ['Notes/../../..'],
    ['./Notes/../../outside'],
  ])('refuses %s', async (path) => {
    const result = await invoke('list_files', { path });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/outside the folder root|Cannot resolve/);
  });

  test('refuses an absolute path outright', async () => {
    const result = await invoke('read_file', { path: '/etc/hosts' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('relative to the folder root');
  });

  test('refuses a home-relative path', async () => {
    const result = await invoke('read_file', { path: '~/.ssh/id_rsa' });

    expect(result.isError).toBe(true);
  });

  test('a symlink pointing out of the root is followed and then refused', async () => {
    // The reason confinement resolves the *real* path first. A link named
    // `escape` looks like an ordinary folder in a listing.
    const result = await invoke('read_file', { path: 'escape/private.txt' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('outside the folder root');
  });

  test('a write outside the root is refused before anything is created', async () => {
    // A path that does not exist yet cannot be resolved, so confinement checks
    // the nearest ancestor that does — otherwise every write escapes.
    const result = await invoke('write_file', { path: 'escape/new.txt', content: 'x' });

    expect(result.isError).toBe(true);
  });
});

describe('what is never reachable', () => {
  test('.git is refused even though it is inside the root', async () => {
    // A repository in a synced folder holds credentials in its config and the
    // history of everything else.
    const result = await invoke('read_file', { path: '.git/config' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('excluded');
  });

  test('and is not listed either', async () => {
    const entries = parsed(await invoke('list_files', {})) as { entries: { path: string }[] };

    expect(entries.entries.map((entry) => entry.path)).not.toContain('.git');
  });
});

describe('reading', () => {
  test('lists a folder with sizes and kinds', async () => {
    const result = parsed(await invoke('list_files', {})) as {
      entries: { path: string; kind: string }[];
    };

    const byPath = new Map(result.entries.map((entry) => [entry.path, entry.kind]));
    expect(byPath.get('readme.md')).toBe('file');
    expect(byPath.get('Notes')).toBe('folder');
  });

  test('reads a text file', async () => {
    expect(parsed(await invoke('read_file', { path: 'readme.md' }))['content']).toContain('coffee');
  });

  test('a binary file reports itself rather than returning noise', async () => {
    const result = parsed(await invoke('read_file', { path: 'photo.png' }));

    expect(result['binary']).toBe(true);
    expect(result['content']).toBeUndefined();
  });

  test('a file over the limit is refused with its size', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2048));

    const result = await invoke('read_file', { path: 'big.txt' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('over the');
  });

  test('searching by name, then by content', async () => {
    const byName = parsed(await invoke('search_files', { query: 'plan' })) as {
      matches: { path: string }[];
    };
    expect(byName.matches.map((match) => match.path)).toContain(join('Notes', 'plan.md'));

    const byContent = parsed(
      await invoke('search_files', { query: '.md', contains: 'coffee' }),
    ) as { matches: { path: string }[] };
    expect(byContent.matches.map((match) => match.path)).toEqual(['readme.md']);
  });
});

describe('files the sync client has evicted', () => {
  test('reading one explains it is not downloaded, and how to fix that', async () => {
    // With "Optimise Mac Storage" on, the real bytes live only in the cloud and
    // a `.name.icloud` placeholder stands in. Reading that returns a few hundred
    // bytes of plist, which looks like a corrupt file rather than an absent one.
    const result = await invoke('read_file', { path: 'evicted.pdf' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not downloaded');
    expect(textOf(result)).toContain('brctl download');
  });

  test('file_info says so rather than claiming the file is missing', async () => {
    expect(parsed(await invoke('file_info', { path: 'evicted.pdf' }))['downloaded']).toBe(false);
  });

  test('the placeholder is not listed as a file of its own', async () => {
    const result = parsed(await invoke('list_files', {})) as { entries: { path: string }[] };

    expect(result.entries.map((entry) => entry.path)).not.toContain('.evicted.pdf.icloud');
  });
});

describe('writing', () => {
  test('creates a file, and will not silently replace one', async () => {
    expect(parsed(await invoke('write_file', { path: 'new.txt', content: 'first' }))['written']).toBe(
      true,
    );

    const second = await invoke('write_file', { path: 'new.txt', content: 'second' });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('overwrite: true');

    expect(
      parsed(await invoke('write_file', { path: 'new.txt', content: 'second', overwrite: true }))[
        'written'
      ],
    ).toBe(true);
  });

  test('moving refuses to clobber the destination', async () => {
    await invoke('write_file', { path: 'a.txt', content: 'a' });
    await invoke('write_file', { path: 'b.txt', content: 'b' });

    const result = await invoke('move_file', { from: 'a.txt', to: 'b.txt' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('already exists');
  });

  test('moving into a new folder creates the parents', async () => {
    await invoke('write_file', { path: 'loose.txt', content: 'x' });

    const result = parsed(await invoke('move_file', { from: 'loose.txt', to: 'Filed/2026/loose.txt' }));

    expect(result['moved']).toBe(true);
  });
});

describe('discovery', () => {
  test('the capability set, and no account-specific routing', async () => {
    const capabilities = await connector().discover({} as DiscoveryContext);

    expect(capabilities.map((capability) => capability.name).sort()).toEqual([
      'create_folder',
      'file_info',
      'list_files',
      'move_file',
      'read_file',
      'search_files',
      'trash_file',
      'write_file',
    ]);
    for (const capability of capabilities) {
      expect(Object.keys(capability.target ?? {})).toEqual(['operation']);
    }
  });

  test('nothing offers a permanent delete', async () => {
    const capabilities = await connector().discover({} as DiscoveryContext);
    const names = capabilities.map((capability) => capability.name);

    // The only removal on offer moves to the Trash, which is recoverable.
    expect(names.filter((name) => /delete|remove|unlink|erase/.test(name))).toEqual([]);
    expect(names).toContain('trash_file');
  });

  test('a root that is not there fails at connect, not later', async () => {
    // The whole point of this kind: it works only where the files are.
    const elsewhere = createFsConnector({
      root: '/nope/not/here',
      maxFileBytes: 1024,
      exclude: [],
    });

    expect(elsewhere.discover({} as DiscoveryContext)).rejects.toThrow(/only works where they are/);
  });
});
