import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

describe('naming a profile', () => {
  test('the flag is the only thing that selects one', async () => {
    const root = await workspace(['personal', 'work'], 'personal');

    expect((await resolveSelection({ env: { LANES_LINK_HOME: root }, profileFlag: 'work' })).profile).toBe(
      'work',
    );
  });

  test('an exported LANES_LINK_PROFILE does not, and the refusal says so', async () => {
    // The precedence chain this replaces made an ignored flag survivable: the
    // command still worked, from a different source, so a mistake surfaced one
    // command later with nothing connecting it to its cause.
    const root = await workspace(['personal', 'work'], 'personal');
    const env = { LANES_LINK_HOME: root, LANES_LINK_PROFILE: 'work' };

    await expect(resolveSelection({ env })).rejects.toThrow('--profile is required');
    await expect(resolveSelection({ env })).rejects.toThrow('LANES_LINK_PROFILE=work');
    await expect(resolveSelection({ env })).rejects.toThrow('no longer read');
  });

  test('nor does default_profile in the workspace file', async () => {
    const root = await workspace(['personal', 'work'], 'personal');

    await expect(resolveSelection({ env: { LANES_LINK_HOME: root } })).rejects.toThrow(
      '--profile is required',
    );
  });

  test('the refusal lists what there is to choose from', async () => {
    const root = await workspace(['personal', 'work'], 'personal');

    await expect(resolveSelection({ env: { LANES_LINK_HOME: root } })).rejects.toThrow(
      /personal[\s\S]*work/,
    );
  });

  test('a named profile that does not exist errors rather than falling back', async () => {
    const root = await workspace(['personal'], 'personal');
    await expect(
      resolveSelection({ env: { LANES_LINK_HOME: root }, profileFlag: 'nope' }),
    ).rejects.toThrow(/Profile "nope" does not exist[\s\S]*Available: personal/);
  });

  test('an empty workspace suggests creating a profile, with a target', async () => {
    const root = await workspace([]);
    await expect(resolveSelection({ env: { LANES_LINK_HOME: root } })).rejects.toThrow(
      /lanes link profile add <name> --target local/,
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
