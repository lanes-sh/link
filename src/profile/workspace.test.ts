import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeSelection,
  listProfiles,
  resolveSelection,
  resolveWorkspaceRoot,
} from './workspace.ts';

const roots: string[] = [];

async function workspace(profiles: string[], defaultProfile?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-ws-'));
  roots.push(root);

  await writeFile(
    join(root, 'lanes-link.yaml'),
    `contract: 1\n${defaultProfile ? `default_profile: ${defaultProfile}\n` : ''}`,
  );
  await mkdir(join(root, 'profiles'), { recursive: true });
  for (const name of profiles) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), `contract: 1\n`);
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace root resolution', () => {
  test('LANES_LINK_HOME wins', async () => {
    const root = await workspace(['personal']);
    expect(resolveWorkspaceRoot({ env: { LANES_LINK_HOME: root }, cwd: '/' })).toBe(root);
  });

  test('otherwise walks up to the nearest lanes-link.yaml', async () => {
    const root = await workspace(['personal']);
    const nested = join(root, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });

    expect(resolveWorkspaceRoot({ env: {}, cwd: nested })).toBe(root);
  });

  test('falls back to ~/.lanes-link when there is no workspace above', () => {
    const resolved = resolveWorkspaceRoot({ env: {}, cwd: tmpdir() });
    expect(resolved.endsWith('.lanes-link')).toBe(true);
  });
});

describe('profile resolution order', () => {
  test('--profile beats the environment, which beats the workspace default', async () => {
    const root = await workspace(['personal', 'work'], 'personal');
    const env = { LANES_LINK_HOME: root, LANES_LINK_PROFILE: 'work' };

    expect((await resolveSelection({ env, profileFlag: 'personal' })).profile).toBe('personal');
    expect((await resolveSelection({ env })).profile).toBe('work');
    expect((await resolveSelection({ env: { LANES_LINK_HOME: root } })).profile).toBe('personal');
  });

  test('records where the selection came from, so commands can print it', async () => {
    const root = await workspace(['personal', 'work'], 'personal');
    const env = { LANES_LINK_HOME: root, LANES_LINK_PROFILE: 'work' };

    expect((await resolveSelection({ env, profileFlag: 'work' })).profileSource).toBe('flag');
    expect((await resolveSelection({ env })).profileSource).toBe('environment');
    expect((await resolveSelection({ env: { LANES_LINK_HOME: root } })).profileSource).toBe(
      'workspace-default',
    );
  });

  test('with nothing selected it errors and lists what is available', async () => {
    const root = await workspace(['personal', 'work']); // no default_profile
    await expect(resolveSelection({ env: { LANES_LINK_HOME: root } })).rejects.toThrow(
      /No profile selected.*personal, work/s,
    );
  });

  test('a named profile that does not exist errors rather than falling back', async () => {
    const root = await workspace(['personal'], 'personal');
    await expect(
      resolveSelection({ env: { LANES_LINK_HOME: root }, profileFlag: 'nope' }),
    ).rejects.toThrow(/Profile "nope" does not exist.*Available: personal/s);
  });

  test('an empty workspace suggests creating a profile', async () => {
    const root = await workspace([]);
    await expect(resolveSelection({ env: { LANES_LINK_HOME: root } })).rejects.toThrow(
      /lanes link profile add/,
    );
  });
});

describe('profile listing', () => {
  test('lists profiles and ignores example files', async () => {
    const root = await workspace(['personal', 'work'], 'personal');
    await writeFile(join(root, 'profiles', 'personal.example.yaml'), 'contract: 1\n');

    expect(await listProfiles(root)).toEqual(['personal', 'work']);
  });
});


describe('the selection line every command prints', () => {
  test('names both the value and where it came from', () => {
    expect(
      describeSelection({
        workspaceRoot: '/ws',
        profile: 'work',
        profilePath: '/ws/profiles/work.yaml',
        target: 'cloud',
        profileSource: 'environment',
        targetSource: 'flag',
      }),
    ).toBe('profile: work (environment)   target: cloud (flag)');
  });
});
