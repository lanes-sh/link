import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateWorkspaceHome } from './workspace-home-migrate.ts';

/**
 * Moving `~/.lanes-link` to `~/.lanes/link`.
 *
 * Written against outcomes rather than internals — what is on disk afterwards —
 * for the reason `contract4.test.ts` states: the defects the last two
 * migrations shipped had in common that they lost, leaked or misrouted data
 * while reporting success.
 *
 * Every case gets a `$HOME` of its own and an install directory of its own,
 * because the two things that decide what this does are where home is and
 * whether this is a checkout. The suite itself runs from one, so a test that
 * did not pin the second would find every case skipped.
 */

const homes: string[] = [];

/** A `$HOME` holding a workspace at the old address, and an install to judge. */
async function machine(
  kind: 'checkout' | 'published' = 'published',
): Promise<{ home: string; from: string; to: string; options: { env: {}; home: string; dir: string } }> {
  const home = await mkdtemp(join(tmpdir(), 'lanes-home-'));
  homes.push(home);

  const dir = join(home, 'install');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"name":"@lanes-sh/link"}\n');
  if (kind === 'checkout') await writeFile(join(dir, 'tsconfig.json'), '{}\n');

  return { home, from: join(home, '.lanes-link'), to: join(home, '.lanes', 'link'), options: { env: {}, home, dir } };
}

/** A workspace with a registry, a credential store, and one profile. */
async function workspaceAt(root: string): Promise<void> {
  await mkdir(join(root, 'profiles', 'ada'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), 'contract: 5\ntargets:\n  local:\n    storage:\n      adapter: filesystem\n');
  await writeFile(join(root, 'credentials.enc'), 'ciphertext', { mode: 0o600 });
  await writeFile(join(root, 'profiles', 'ada', 'profile.yaml'), 'contract: 5\n');
  await chmod(root, 0o700);
}

afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

describe('moving the workspace', () => {
  test('apply: false reports the move and writes nothing', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);

    const migration = await migrateWorkspaceHome({ ...options, apply: false });

    expect(migration.alreadyCurrent).toBe(false);
    expect(migration.changes).toEqual([`workspace ${from} → ${to}`]);
    expect(existsSync(to)).toBe(false);
    expect(await readFile(join(from, 'credentials.enc'), 'utf8')).toBe('ciphertext');
  });

  test('the whole workspace arrives, and the old root is gone', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);

    const migration = await migrateWorkspaceHome({ ...options, apply: true });

    expect(migration.blocked).toEqual([]);
    expect(existsSync(from)).toBe(false);
    expect(await readFile(join(to, 'credentials.enc'), 'utf8')).toBe('ciphertext');
    expect(await readFile(join(to, 'profiles', 'ada', 'profile.yaml'), 'utf8')).toBe('contract: 5\n');
  });

  test('a second run has nothing to do', async () => {
    const { from, options } = await machine();
    await workspaceAt(from);

    await migrateWorkspaceHome({ ...options, apply: true });
    expect((await migrateWorkspaceHome({ ...options, apply: true })).alreadyCurrent).toBe(true);
  });

  test('nothing to do on a machine that never had one', async () => {
    const { options } = await machine();
    expect((await migrateWorkspaceHome({ ...options, apply: true })).alreadyCurrent).toBe(true);
  });

  test('the credential store stays 0600 and neither directory becomes readable', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);

    await migrateWorkspaceHome({ ...options, apply: true });

    expect((await stat(join(to, 'credentials.enc'))).mode & 0o777).toBe(0o600);
    expect((await stat(to)).mode & 0o777).toBe(0o700);
    // `~/.lanes` is created by this command when the desktop app has not already
    // made it, and what goes inside is a credential store.
    expect((await stat(join(options.home, '.lanes'))).mode & 0o777).toBe(0o700);
  });
});

describe('what it will not do', () => {
  test('nothing, from a checkout', async () => {
    // Applying this from a worktree would move the operator's real workspace
    // into a scratch home — the accident dev mode exists to prevent, reached
    // from the other side.
    const { from, to, options } = await machine('checkout');
    await workspaceAt(from);

    expect((await migrateWorkspaceHome({ ...options, apply: true })).alreadyCurrent).toBe(true);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  test('nothing, when LANES_LINK_HOME names a root', async () => {
    const { from, options } = await machine();
    await workspaceAt(from);

    const pinned = { ...options, env: { LANES_LINK_HOME: '/somewhere/else' }, apply: true };
    expect((await migrateWorkspaceHome(pinned)).alreadyCurrent).toBe(true);
    expect(existsSync(from)).toBe(true);
  });

  test('refuses when both roots hold a workspace, and moves neither', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);
    await workspaceAt(to);
    await writeFile(join(to, 'credentials.enc'), 'a different one', { mode: 0o600 });

    const migration = await migrateWorkspaceHome({ ...options, apply: true });

    expect(migration.blocked).toHaveLength(1);
    expect(migration.blocked[0]).toContain('two workspaces');
    expect(await readFile(join(from, 'credentials.enc'), 'utf8')).toBe('ciphertext');
    expect(await readFile(join(to, 'credentials.enc'), 'utf8')).toBe('a different one');
  });

  test('refuses while an endpoint is serving the old root', async () => {
    // A running `start` holds that path. Moving out from under it leaves a
    // process serving a directory nobody can find.
    const { from, to, options } = await machine();
    await workspaceAt(from);
    await writeFile(
      join(from, 'endpoint.json'),
      JSON.stringify({ url: 'http://127.0.0.1:7400/mcp', pid: process.pid, profiles: ['ada'], startedAt: new Date().toISOString() }),
    );

    const migration = await migrateWorkspaceHome({ ...options, apply: true });

    expect(migration.blocked[0]).toContain('an endpoint is serving');
    expect(existsSync(to)).toBe(false);
  });

  test('a dead pid is not a running endpoint', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);
    await writeFile(
      join(from, 'endpoint.json'),
      JSON.stringify({ url: 'http://127.0.0.1:7400/mcp', pid: 2 ** 30, profiles: ['ada'], startedAt: new Date().toISOString() }),
    );

    expect((await migrateWorkspaceHome({ ...options, apply: true })).blocked).toEqual([]);
    expect(existsSync(to)).toBe(true);
  });

  test('refuses when a target names an absolute path inside the old root', async () => {
    // The one that would otherwise be silent: `workspacePath` honours an
    // absolute path verbatim, so this would go on naming a directory the
    // migration had just emptied — and here that is the credential store.
    const { from, to, options } = await machine();
    await workspaceAt(from);
    await writeFile(
      join(from, 'workspaces.yaml'),
      `contract: 5\ntargets:\n  local:\n    credentials:\n      adapter: file\n      path: ${join(from, 'credentials.enc')}\n`,
    );

    const migration = await migrateWorkspaceHome({ ...options, apply: true });

    expect(migration.blocked).toHaveLength(1);
    expect(migration.blocked[0]).toContain('credentials.enc is an absolute path');
    expect(existsSync(to)).toBe(false);
  });

  test('a relative path is fine, because it travels with the workspace', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);
    await writeFile(
      join(from, 'workspaces.yaml'),
      'contract: 5\ntargets:\n  local:\n    credentials:\n      adapter: file\n      path: credentials.enc\n',
    );

    expect((await migrateWorkspaceHome({ ...options, apply: true })).blocked).toEqual([]);
    expect(existsSync(to)).toBe(true);
  });
});

describe('across two filesystems, where rename cannot help', () => {
  /** What `rename` does when the two paths are on different volumes. */
  const crossDevice = async (): Promise<void> => {
    const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
    error.code = 'EXDEV';
    throw error;
  };

  test('it copies, verifies, and only then deletes', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);

    const migration = await migrateWorkspaceHome({ ...options, apply: true, deps: { rename: crossDevice } });

    expect(migration.blocked).toEqual([]);
    expect(existsSync(from)).toBe(false);
    expect(await readFile(join(to, 'credentials.enc'), 'utf8')).toBe('ciphertext');
    expect((await stat(join(to, 'credentials.enc'))).mode & 0o777).toBe(0o600);
    // `cp` carries every file's mode and every nested directory's, but leaves
    // the destination root at the umask — 0755 — unless it is set explicitly.
    expect((await stat(to)).mode & 0o777).toBe(0o700);
  });

  test('an interrupted copy is finished by the next run, not refused by it', async () => {
    // A crash between the copy and the delete leaves both roots. That is the
    // one shape of "both exist" that is not two workspaces, and the evidence
    // separating them is whether the new root already holds everything.
    const { from, to, options } = await machine();
    await workspaceAt(from);
    await mkdir(to, { recursive: true, mode: 0o700 });
    await cp(from, to, { recursive: true });

    const migration = await migrateWorkspaceHome({ ...options, apply: true });

    expect(migration.blocked).toEqual([]);
    expect(migration.changes[0]).toContain('already copied');
    expect(existsSync(from)).toBe(false);
    expect(await readFile(join(to, 'credentials.enc'), 'utf8')).toBe('ciphertext');
  });

  test('a copy that stopped partway deletes nothing', async () => {
    const { from, to, options } = await machine();
    await workspaceAt(from);

    // Half a workspace at the destination: the registry made it, the credential
    // store did not. A directory test would call this a workspace and refuse
    // forever; the read-back sees what is missing.
    await mkdir(to, { recursive: true, mode: 0o700 });
    await writeFile(join(to, 'workspaces.yaml'), 'contract: 5\n');

    const migration = await migrateWorkspaceHome({ ...options, apply: true });

    expect(migration.blocked).toHaveLength(1);
    expect(await readFile(join(from, 'credentials.enc'), 'utf8')).toBe('ciphertext');
  });
});
