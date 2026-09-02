import { workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listProfiles,
  loadWorkspaceProfiles,
  resolveSelection,
  resolveWorkspaceRoot,
} from './workspace.ts';

const roots: string[] = [];

async function workspace(profiles: string[], defaultProfile?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-ws-'));
  roots.push(root);

  await writeFile(
    join(root, 'workspaces.yaml'),
    `contract: 1\n${defaultProfile ? `default_profile: ${defaultProfile}\n` : ''}`,
  );
  await mkdir(join(root, 'profiles', 'alpha'), { recursive: true });
  for (const name of profiles) {
    await writeProfileFixture(root, name, `contract: 1\n`);
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
      /lanes link profile add <name> --workspace local/,
    );
  });
});

describe('a workspace that has not been migrated yet', () => {
  /**
   * `listProfiles` understands both layouts and the lookup understands one,
   * which is deliberate — a workspace needing migration has to be findable by
   * the command that migrates it. What it produced together was a refusal
   * reading "profile personal does not exist. Available: personal", naming no
   * way forward. ADR-051 is the standing rule: a refusal has to name a command,
   * and the command has to exist.
   */
  async function contract3(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-c3-'));
    roots.push(root);
    await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', `${name}.yaml`), 'contract: 3\n');
    return root;
  }

  test('a profile at the old path is told how to move, not told it is absent', async () => {
    const root = await contract3('personal');

    await expect(
      resolveSelection({ env: { LANES_LINK_HOME: root }, profileFlag: 'personal' }),
    ).rejects.toThrow(/contract 3[\s\S]*lanes link doctor --fix/);
  });

  test('a profile that really is absent still says so', async () => {
    const root = await contract3('personal');

    await expect(
      resolveSelection({ env: { LANES_LINK_HOME: root }, profileFlag: 'work' }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('profile listing', () => {
  test('lists profiles and ignores example files', async () => {
    const root = await workspace(['personal', 'work'], 'personal');
    await writeFile(join(root, 'profiles', 'personal.example.yaml'), workspaceYaml(['local']));

    expect(await listProfiles(root)).toEqual(['personal', 'work']);
  });
});

/**
 * Reading the whole workspace, for the commands whose subject is the target.
 *
 * A target is declared per profile and the endpoint serves every profile
 * (ADR-009, ADR-043), so "which profiles have `cloud`" is the question these
 * answer — and the interesting answer is "not all of them", which is what a
 * deployment looks like after the only file naming it was rewritten.
 */
describe('reading every profile at once', () => {
  async function withTargets(profiles: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-ws-'));
    roots.push(root);

    await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
    await mkdir(join(root, 'profiles', 'alpha'), { recursive: true });
    for (const [name, body] of Object.entries(profiles)) {
      await writeProfileFixture(root, name, body);
    }
    return root;
  }

  /**
   * A profile, which declares no target.
   *
   * It used to take the list of targets it declared, and the tests below asked
   * which profiles declared each. That question is gone with ADR-052: a target
   * is declared once by the workspace, so there is no per-profile answer to
   * disagree about — and it was the disagreement that made a live deployment
   * look vanished from inside one profile.
   */
  const declaring = (profile: string): string =>
    `contract: 5\ninstance: { profile: ${profile} }\n`;

  test('loads each profile with its config', async () => {
    const root = await withTargets({
      alpha: declaring('alpha'),
      beta: declaring('beta'),
    });

    const workspace = await loadWorkspaceProfiles(root);

    expect(workspace.loaded.map((entry) => entry.profile)).toEqual(['alpha', 'beta']);
    expect(workspace.unreadable).toEqual([]);
    expect(workspace.loaded[0]!.profilePath).toBe(join(root, 'profiles', 'alpha', 'profile.yaml'));
  });

  test('a profile that will not parse is reported, not thrown', async () => {
    // The endpoint serves what it can open and skips the rest; a listing that
    // dies on the first bad file stops working exactly when it is needed.
    const root = await withTargets({
      alpha: declaring('alpha'),
      broken: 'contract: 5\ninstance: {}\n',
    });

    const workspace = await loadWorkspaceProfiles(root);

    expect(workspace.loaded.map((entry) => entry.profile)).toEqual(['alpha']);
    expect(workspace.unreadable.map((entry) => entry.profile)).toEqual(['broken']);
    expect(workspace.unreadable[0]!.reason).not.toContain('\n');
  });

  test('every profile in the workspace is one this target can open', async () => {
    // The two tests this replaces asserted the opposite property: which profiles
    // declared `cloud`, and that a target nobody declared was absent. Neither
    // question exists now — a profile is in this workspace, so it is one the
    // endpoint here will open (ADR-052).
    const root = await withTargets({
      alpha: declaring('alpha'),
      beta: declaring('beta'),
    });

    const workspace = await loadWorkspaceProfiles(root);

    expect(workspace.loaded.map((entry) => entry.profile)).toEqual(['alpha', 'beta']);
    expect(workspace.loaded.every((entry) => entry.config.instance.profile)).toBe(true);
  });
});
