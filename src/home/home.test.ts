import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultWorkspaceRoot,
  homeWorkspaceRoot,
  installRoot,
  isDevInstall,
  lanesHome,
  legacyWorkspaceRoot,
} from './index.ts';

/**
 * Where Lanes keeps things, asserted against a `$HOME` this file owns.
 *
 * Every function here takes its home, its environment and the directory that
 * decides dev mode as arguments, and the reason is this file: the suite runs
 * from a checkout, so a test that read the real `homedir()` or the real
 * `import.meta.dir` would be asserting against whichever machine ran it.
 */

const made: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  made.push(path);
  return path;
}

/** A directory shaped like whichever of the two things dev mode distinguishes. */
async function install(kind: 'checkout' | 'published'): Promise<string> {
  const root = await scratch(`lanes-${kind}-`);
  await writeFile(join(root, 'package.json'), '{"name":"@lanes-sh/link"}\n');
  if (kind === 'checkout') await writeFile(join(root, 'tsconfig.json'), '{}\n');
  return root;
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })));
});

describe('telling a checkout from an install', () => {
  test('a tsconfig.json at the install root means a checkout', async () => {
    expect(isDevInstall({ env: {}, dir: await install('checkout') })).toBe(true);
  });

  test('and its absence means a published copy', async () => {
    // The file is in neither `package.json`'s `files` array nor the Dockerfile's
    // COPY, which is the whole reason it is the signal: a published tarball
    // cannot carry one, and — unlike a `node_modules` path test — a `bun link`
    // symlink cannot make a checkout look like one either.
    expect(isDevInstall({ env: {}, dir: await install('published') })).toBe(false);
  });

  test('nothing above at all is not a checkout, and does not throw', async () => {
    // `installRoot` throws when there is no `package.json` anywhere above. That
    // is a real answer to a different question, and no reason to fail a command
    // that was only asking where to look for a file.
    const orphan = await scratch('lanes-orphan-');
    expect(() => installRoot(orphan)).toThrow('No package.json');
    expect(isDevInstall({ env: {}, dir: orphan })).toBe(false);
  });

  test('LANES_LINK_DEV overrides in both directions', async () => {
    const published = await install('published');
    const checkout = await install('checkout');

    expect(isDevInstall({ env: { LANES_LINK_DEV: '1' }, dir: published })).toBe(true);
    expect(isDevInstall({ env: { LANES_LINK_DEV: 'true' }, dir: published })).toBe(true);
    expect(isDevInstall({ env: { LANES_LINK_DEV: '0' }, dir: checkout })).toBe(false);
    expect(isDevInstall({ env: { LANES_LINK_DEV: 'false' }, dir: checkout })).toBe(false);
  });

  test('an exported-but-empty LANES_LINK_DEV is not an answer', async () => {
    // `export LANES_LINK_DEV=` is a shell artefact. Reading it as `true` would
    // put somebody in a scratch home with nothing on screen to say why.
    expect(isDevInstall({ env: { LANES_LINK_DEV: '' }, dir: await install('published') })).toBe(false);
  });
});

describe('the directories', () => {
  test('an install keeps ~/.lanes, a checkout gets ~/.lanes-dev', async () => {
    const home = '/home/ada';
    const published = { env: {}, home, dir: await install('published') };
    const checkout = { env: {}, home, dir: await install('checkout') };

    expect(lanesHome(published)).toBe('/home/ada/.lanes');
    expect(defaultWorkspaceRoot(published)).toBe('/home/ada/.lanes/link');
    expect(lanesHome(checkout)).toBe('/home/ada/.lanes-dev');
    expect(defaultWorkspaceRoot(checkout)).toBe('/home/ada/.lanes-dev/link');
  });

  test('the legacy root is not under the Lanes home, in either mode', async () => {
    // There was never a dev copy of `~/.lanes-link`, so it composes from $HOME
    // directly. A checkout asking for it is asking about the operator's real
    // workspace, which is the thing `homeWorkspaceRoot` will not hand back.
    const home = '/home/ada';
    for (const kind of ['published', 'checkout'] as const) {
      expect(legacyWorkspaceRoot({ env: {}, home, dir: await install(kind) })).toBe(
        '/home/ada/.lanes-link',
      );
    }
  });
});

describe('which root a command falls back to', () => {
  const home = '/home/ada';
  const only = (workspace: string) => (directory: string) => directory === workspace;
  const none = () => false;

  test('the new root, when a workspace is there', async () => {
    const options = { env: {}, home, dir: await install('published') };
    expect(homeWorkspaceRoot(only('/home/ada/.lanes/link'), options)).toBe('/home/ada/.lanes/link');
  });

  test('the legacy root, when the workspace is still there', async () => {
    const options = { env: {}, home, dir: await install('published') };
    expect(homeWorkspaceRoot(only('/home/ada/.lanes-link'), options)).toBe('/home/ada/.lanes-link');
  });

  test('the new root when neither exists, so a fresh install creates that one', async () => {
    const options = { env: {}, home, dir: await install('published') };
    expect(homeWorkspaceRoot(none, options)).toBe('/home/ada/.lanes/link');
  });

  test('a checkout is never handed the legacy root', async () => {
    // The whole point of dev mode. Falling back onto `~/.lanes-link` from a
    // worktree reaches live profiles, credentials and an audit log, and both
    // `deploy` and `sync targets` write there.
    const options = { env: {}, home, dir: await install('checkout') };
    expect(homeWorkspaceRoot(only('/home/ada/.lanes-link'), options)).toBe(
      '/home/ada/.lanes-dev/link',
    );
  });

  test('a bare directory is not a workspace — the predicate decides, not the path', async () => {
    // `~/.lanes` belongs to the desktop app, so `~/.lanes/link` can come into
    // existence without a workspace in it, and an interrupted copy leaves
    // exactly that. Preferring it would report "no profiles here" and strand
    // the intact old root from the command that migrates it.
    const options = { env: {}, home, dir: await install('published') };
    expect(homeWorkspaceRoot(only('/home/ada/.lanes-link'), options)).toBe('/home/ada/.lanes-link');
  });
});
