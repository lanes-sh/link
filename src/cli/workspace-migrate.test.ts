import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyTargetSchema, readRegistry } from '#profile';
import { migrateWorkspace, needsMigration } from './workspace-migrate.ts';
import { toEntry } from './migrate-plan.ts';

/**
 * Contract 1 → 2, against the shapes a real workspace actually holds.
 *
 * Every case here is one that got through review and was caught by running the
 * thing against a live bucket, which is the argument for the file existing: the
 * migration reads somebody's only copy of where their accounts are, and its
 * failures are the quiet kind.
 */

const roots: string[] = [];

/** A contract-1 profile declaring the given target blocks. */
const legacy = (profile: string, targets: string): string =>
  `contract: 1\ninstance:\n  profile: ${profile}\n  default_target: local\ntargets:\n${targets}` +
  `connections:\n  - { id: main, provider: setup, account: Setup }\npolicy:\n  allow: [setup.*]\n`;

const LOCAL = `  local:\n    credentials: { adapter: file, path: ./data/PROFILE/credentials.enc }\n    storage: { adapter: filesystem, path: ./data/PROFILE }\n`;

const CLOUD = `  cloud:\n    credentials: { adapter: gcp-secret-manager, project: my-project }\n    storage: { adapter: gcs, bucket: personal-lanes }\n    vault: { adapter: secret }\n`;

async function workspace(
  profiles: Record<string, string>,
  file = 'contract: 1\ndefault_profile: personal\n',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-migrate-'));
  roots.push(root);
  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'lanes-link.yaml'), file);
  for (const [name, body] of Object.entries(profiles)) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), body);
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('hoisting a profile’s targets into the workspace', () => {
  test('a local target is declared here and a bucket becomes a pointer', async () => {
    const root = await workspace({
      personal: legacy('personal', LOCAL.replaceAll('PROFILE', 'personal') + CLOUD),
    });

    await migrateWorkspace(root);
    const registry = await readRegistry(root);

    expect(registry['local']?.storage?.adapter).toBe('filesystem');
    expect(registry['cloud']?.at).toBe('gs://personal-lanes');
    expect(registry['cloud']?.storage).toBeUndefined();
  });

  test('the profile keeps everything except its targets', async () => {
    const root = await workspace({
      personal: legacy('personal', LOCAL.replaceAll('PROFILE', 'personal')),
    });

    await migrateWorkspace(root);
    const written = await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8');

    // This migration produces contract 2, and `migrateToContract3` takes it the
    // rest of the way — so the number here is literally 2, not the newest.
    expect(written).toContain('contract: 2');
    expect(written).not.toContain('targets:');
    expect(written).not.toContain('default_target');
    expect(written).toContain('provider: setup');
  });

  test('two profiles declaring one target disagree loudly rather than silently', async () => {
    const other = `  cloud:\n    credentials: { adapter: gcp-secret-manager, project: other }\n    storage: { adapter: gcs, bucket: someone-else }\n`;
    const root = await workspace({
      personal: legacy('personal', CLOUD),
      work: legacy('work', other),
    });

    await expect(migrateWorkspace(root)).rejects.toThrow(/do not agree/);
  });

  test('a custom path is refused, because one target cannot hold two', async () => {
    const custom = `  local:\n    credentials: { adapter: file, path: ./data/personal/credentials.enc }\n    storage: { adapter: filesystem, path: ./somewhere-else }\n`;
    const root = await workspace({ personal: legacy('personal', custom) });

    await expect(migrateWorkspace(root)).rejects.toThrow(/custom storage.path/);
  });
});

describe('migrating the workspace a target already lives in', () => {
  /**
   * The bucket's own copy, which is the second end of the same migration.
   *
   * Against `toEntry` rather than the whole run, because the decision under test
   * is "what does *this* workspace make of this target block" and the only thing
   * that varies is which workspace is asking. Driving it through
   * `migrateWorkspace` would need a real bucket to be the root.
   */
  const parse = (yaml: string) =>
    legacyTargetSchema.parse({
      credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
      storage: { adapter: 'gcs', bucket: 'personal-lanes' },
      vault: { adapter: 'secret' },
      ...(yaml === 'filesystem'
        ? { credentials: { adapter: 'file' }, storage: { adapter: 'filesystem' } }
        : {}),
    });

  test('a target whose bucket is this workspace declares itself, never points at itself', () => {
    // From a laptop the same block is a pointer; from inside the bucket it is the
    // declaration. Getting this wrong wrote `gs://b` pointing at `gs://b`, which
    // `openTarget` refuses as a loop — leaving `deploy` unable to run against the
    // bucket it had just migrated, on the one command the refusal names as the fix.
    const fromLaptop = toEntry('cloud', parse('gcs'), 'personal', '/Users/x/.lanes-link');
    expect(fromLaptop?.at).toBe('gs://personal-lanes');

    const fromBucket = toEntry('cloud', parse('gcs'), 'personal', 'gs://personal-lanes');
    expect(fromBucket?.at).toBeUndefined();
    expect(fromBucket?.storage?.bucket).toBe('personal-lanes');
  });

  test('and a filesystem target is dropped, because a bucket can never open one', () => {
    // The bucket's copy of a profile was uploaded from a laptop, so it carries
    // that laptop's `local:` block — paths on a disk the endpoint has never seen.
    expect(toEntry('local', parse('filesystem'), 'personal', 'gs://personal-lanes')).toBeNull();

    // On the machine that owns it, it is kept.
    expect(toEntry('local', parse('filesystem'), 'personal', '/Users/x/.lanes-link')).not.toBeNull();
  });
});

describe('reporting without writing', () => {
  test('apply: false changes nothing on disk', async () => {
    // `deploy --dry-run` runs this, and a dry run that migrated a bucket for real
    // is how the live endpoint in front of one stopped being able to read it.
    const root = await workspace({
      personal: legacy('personal', LOCAL.replaceAll('PROFILE', 'personal') + CLOUD),
    });
    const before = await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8');

    const plan = await migrateWorkspace(root, { apply: false });

    expect(plan.alreadyCurrent).toBe(false);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(await readFile(join(root, 'profiles', 'personal.yaml'), 'utf8')).toBe(before);
    expect(await readRegistry(root)).toEqual({});
    expect(await needsMigration(root)).toBe(true);
  });

  test('a workspace already at contract 2 is a no-op that says so', async () => {
    const root = await workspace({ personal: legacy('personal', LOCAL.replaceAll('PROFILE', 'personal')) });
    await migrateWorkspace(root);

    const again = await migrateWorkspace(root);

    expect(again.alreadyCurrent).toBe(true);
    expect(again.changes).toEqual([]);
    expect(await needsMigration(root)).toBe(false);
  });
});
