import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBlobs,
  applyPulls,
  applyPushes,
  planBlobs,
  planProfile,
  profilesInEither,
  resolved,
} from './sync-apply.ts';

/**
 * Writing a difference down, once it has been decided.
 *
 * The properties worth holding are all about what is *not* written: no default
 * that zod filled in on the way past, no credential store, nothing at all when
 * two copies disagree and nobody said which wins.
 */

const roots: string[] = [];

const PROFILE = `# an operator comment
contract: 1
instance: { profile: personal, port: 7337 }
targets:
  local:
    credentials: { adapter: file, path: ./data/personal/credentials.enc }
    storage: { adapter: filesystem, path: ./data/personal }
`;

const CLOUD = `  cloud:
    credentials: { adapter: gcp-secret-manager, project: my-project }
    storage: { adapter: gcs, bucket: your-bucket }
    vault: { adapter: secret }
    deploy:
      platform: cloudrun
      project: my-project
      region: europe-west1
      service: lanes-link-personal-mcp
      access: public
`;

async function workspace(profiles: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-sync-'));
  roots.push(root);

  await writeFile(join(root, 'lanes-link.yaml'), 'contract: 1\n');
  await mkdir(join(root, 'profiles'), { recursive: true });
  for (const [name, body] of Object.entries(profiles)) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), body);
  }
  return root;
}

const read = (root: string, profile: string): Promise<string> =>
  readFile(join(root, 'profiles', `${profile}.yaml`), 'utf8');

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('pulling what the local copy has lost', () => {
  test('the target block comes back, and the comment survives it', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE + CLOUD });

    const plan = await planProfile(local, remote, 'personal', undefined);
    await applyPulls(local, remote, 'personal', plan.changes);

    const recovered = await read(local, 'personal');
    expect(recovered).toContain('# an operator comment');
    expect(recovered).toContain('service: lanes-link-personal-mcp');
    expect(recovered).toContain('bucket: your-bucket');
  });

  test('and brings none of the defaults zod filled in on the way past', async () => {
    // The diff compares validated configs so `[gmail.*]` and
    // `[{capability: gmail.*}]` are equal; what gets *written* has to come from
    // the raw document, or a recovery quietly rewrites the operator's file.
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE + CLOUD });

    const plan = await planProfile(local, remote, 'personal', undefined);
    await applyPulls(local, remote, 'personal', plan.changes);

    const recovered = await read(local, 'personal');
    expect(recovered).not.toContain('min_instances');
    expect(recovered).not.toContain('access_token_ttl_minutes');
  });

  test('a policy rule keeps the shape it was written in', async () => {
    const withPolicy = (rules: string): string =>
      `${PROFILE}connections:\n  - { id: work, provider: gmail, account: someone@example.com }\n` +
      `policy:\n  allow: [${rules}]\n`;

    const local = await workspace({ personal: withPolicy('gmail.read_message') });
    const remote = await workspace({ personal: withPolicy('gmail.read_message, gmail.send_message') });

    const plan = await planProfile(local, remote, 'personal', undefined);
    await applyPulls(local, remote, 'personal', plan.changes);

    const recovered = await read(local, 'personal');
    expect(recovered).toContain('- gmail.send_message');
    expect(recovered).not.toContain('capability: gmail.send_message');
  });

  test('applying twice changes nothing the second time', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE + CLOUD });

    await applyPulls(local, remote, 'personal', (await planProfile(local, remote, 'personal', undefined)).changes);
    const once = await read(local, 'personal');

    const second = await planProfile(local, remote, 'personal', undefined);
    expect(second.changes).toEqual([]);
    expect(await read(local, 'personal')).toBe(once);
  });

  test('a profile only the deployment has is copied whole', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE, work: PROFILE });

    expect(await profilesInEither(local, remote)).toEqual(['personal', 'work']);

    const plan = await planProfile(local, remote, 'work', undefined);
    expect(plan.onlyRemote).toBe(true);
    await applyPulls(local, remote, 'work', plan.changes);

    expect(await read(local, 'work')).toContain('# an operator comment');
  });
});

describe('pushing what the deployment has lost', () => {
  test('the local file goes up once it holds the union', async () => {
    const local = await workspace({ personal: PROFILE + CLOUD });
    const remote = await workspace({ personal: PROFILE });

    const plan = await planProfile(local, remote, 'personal', undefined);
    expect(await applyPushes(local, remote, 'personal', plan.changes)).toBe(true);
    expect(await read(remote, 'personal')).toContain('service: lanes-link-personal-mcp');
  });

  test('nothing is pushed when nothing is missing remotely', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE + CLOUD });

    const plan = await planProfile(local, remote, 'personal', undefined);
    expect(await applyPushes(local, remote, 'personal', plan.changes)).toBe(false);
  });
});

describe('a conflict is not resolved by guessing', () => {
  const differing = async (): Promise<[string, string]> => [
    await workspace({ personal: PROFILE }),
    await workspace({ personal: PROFILE.replace('port: 7337', 'port: 7339') }),
  ];

  test('with no --prefer it stays a conflict, and nothing is written', async () => {
    const [local, remote] = await differing();
    const before = await read(local, 'personal');

    const plan = await planProfile(local, remote, 'personal', undefined);
    const changes = resolved(plan.changes, undefined);

    expect(changes.every((change) => change.direction === 'conflict')).toBe(true);
    await applyPulls(local, remote, 'personal', changes);
    expect(await read(local, 'personal')).toBe(before);
  });

  test('--prefer remote turns it into a pull', async () => {
    const [local, remote] = await differing();

    const plan = await planProfile(local, remote, 'personal', 'remote');
    await applyPulls(local, remote, 'personal', resolved(plan.changes, 'remote'));

    expect(await read(local, 'personal')).toContain('7339');
  });

  test('--prefer local pushes, and never reads the remote copy for changes', async () => {
    // Told local wins outright, there is nothing to ask the remote copy: every
    // answer it could give is already decided.
    const [local, remote] = await differing();

    const plan = await planProfile(local, remote, 'personal', 'local');
    expect(plan.changes.every((change) => change.direction === 'push')).toBe(true);

    await applyPushes(local, remote, 'personal', resolved(plan.changes, 'local'));
    expect(await read(remote, 'personal')).toContain('7337');
  });
});

describe('skills and manifests ride the deploy allowlist', () => {
  async function withData(root: string, files: Record<string, string>): Promise<void> {
    for (const [key, body] of Object.entries(files)) {
      const path = join(root, key);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
  }

  test('a skill only the deployment has is pulled', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE });
    await withData(remote, { 'data/personal/skills.d/invoicing/SKILL.md': '# invoicing\n' });

    const blobs = await planBlobs(local, remote);
    expect(blobs).toMatchObject([
      { key: 'data/personal/skills.d/invoicing/SKILL.md', direction: 'pull' },
    ]);

    expect(await applyBlobs(local, remote, blobs)).toBe(1);
    expect(await readFile(join(local, blobs[0]!.key), 'utf8')).toBe('# invoicing\n');
  });

  test('a credential store is never one of them, in either direction', async () => {
    // The allowlist is what keeps a decryptable credential document out of a
    // bucket. A sync reaching into `data/` for anything else would undo it.
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE });
    await withData(local, {
      'data/personal/credentials.enc': 'ciphertext',
      'data/personal/credentials.enc.key': 'key',
      'data/personal/state.kv/connections': '{}',
      'data/personal/audit.log/2026/evt.json': '{}',
      'data/personal/skills.detour/SKILL.md': 'not a skill directory',
    });

    expect(await planBlobs(local, remote)).toEqual([]);
  });

  test('differing content is a conflict, not a silent overwrite', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE });
    await withData(local, { 'data/personal/skills.d/a/SKILL.md': 'local\n' });
    await withData(remote, { 'data/personal/skills.d/a/SKILL.md': 'remote\n' });

    expect(await planBlobs(local, remote)).toMatchObject([{ direction: 'conflict' }]);
  });

  test('identical content is not a change', async () => {
    const local = await workspace({ personal: PROFILE });
    const remote = await workspace({ personal: PROFILE });
    await withData(local, { 'data/personal/providers.d/thing.yaml': 'id: thing\n' });
    await withData(remote, { 'data/personal/providers.d/thing.yaml': 'id: thing\n' });

    expect(await planBlobs(local, remote)).toEqual([]);
  });
});
