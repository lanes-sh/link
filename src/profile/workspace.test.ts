import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './load.ts';
import {
  describeSelection,
  listProfiles,
  resolveDeployTarget,
  resolveSelection,
  resolveTarget,
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

describe('target resolution', () => {
  const twoTargets = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage: { adapter: filesystem, path: ./data/files }
  cloud:
    credentials: { adapter: gcp-secret-manager }
    storage: { adapter: s3, bucket: lanes-link-demo }
    cloudrun: { project: p, region: r, service: s }
`).config;

  const localOnly = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage: { adapter: filesystem, path: ./data/files }
`).config;

  const twoDeployable = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: cloud
targets:
  cloud:
    credentials: { adapter: gcp-secret-manager, project: p }
    storage: { adapter: gcs, bucket: b }
    deploy: { platform: cloudrun, project: p, region: r, service: s }
  staging:
    credentials: { adapter: gcp-secret-manager, project: p2 }
    storage: { adapter: gcs, bucket: b2 }
    deploy: { platform: cloudrun, project: p2, region: r, service: s2 }
`).config;

  test('defaults to instance.default_target', () => {
    expect(resolveTarget(twoTargets)).toEqual({ target: 'local', source: 'config-default' });
  });

  test('--target overrides it', () => {
    expect(resolveTarget(twoTargets, 'cloud')).toEqual({ target: 'cloud', source: 'flag' });
  });

  test('one config yields a different adapter set per target', () => {
    // Connections, providers, and policy are declared once and apply to every
    // target; only the adapters differ.
    expect(twoTargets.targets['local']?.storage.adapter).toBe('filesystem');
    expect(twoTargets.targets['cloud']?.storage.adapter).toBe('s3');
    expect(twoTargets.targets['local']?.credentials.adapter).toBe('file');
    expect(twoTargets.targets['cloud']?.credentials.adapter).toBe('gcp-secret-manager');
  });

  test('an undeclared target fails and lists what exists', () => {
    expect(() => resolveTarget(twoTargets, 'staging')).toThrow(
      /Target "staging" is not declared.*local, cloud/s,
    );
  });

  test('a deploy works out which target it meant', () => {
    // `--target cloud` was required on every deploy because an absent flag fell
    // back to `instance.default_target` — `local`, a target that is by
    // definition not deployed. The one command whose subject is never ambiguous
    // was the one that made you say it.
    expect(resolveDeployTarget(twoTargets)).toEqual({ target: 'cloud', source: 'deployable' });
  });

  test('--target still wins, which is how you deploy the second one', () => {
    expect(resolveDeployTarget(twoTargets, 'staging')).toEqual({
      target: 'staging',
      source: 'flag',
    });
  });

  test('with nothing deployable it proposes the conventional name', () => {
    // The first run: no target has a deployment yet, and `cloud` is what every
    // example names. The survey then creates it.
    expect(resolveDeployTarget(localOnly)).toEqual({ target: 'cloud', source: 'deployable' });
  });

  test('two deployable targets is a real question, so it asks', () => {
    // Rolling a revision to whichever came first in a YAML mapping is the one
    // answer that cannot be right on purpose.
    expect(() => resolveDeployTarget(twoDeployable)).toThrow(
      /2 deployable targets \(cloud, staging\).*--target/s,
    );
  });

  test('unless the caller is going to create it', () => {
    // `deploy` on a first run: the target it names is the one it is about to
    // write. Refusing there made a command whose whole job is bootstrapping
    // demand that the thing already exist. Nothing else passes this — a typo
    // in `--target` should still hit the list above rather than quietly
    // deploying a target nobody declared.
    expect(resolveTarget(twoTargets, 'staging', { allowUndeclared: true })).toEqual({
      target: 'staging',
      source: 'flag',
    });
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
