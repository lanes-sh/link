import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { migrateToContract3 } from './contract3.ts';

/**
 * Contract 2 to contract 3, against a real workspace on disk.
 *
 * This file did not exist, and the migration it covers carries every existing
 * operator's credentials, vault, memory and tasks through a breaking change.
 * Four separate defects were found in it by review, three of which lost, leaked
 * or misrouted data *while reporting success* — so the tests below are written
 * against the outcomes rather than the internals: what is in the files
 * afterwards, and what is in the blob store.
 *
 * The fixtures are the shapes that actually collide. Two profiles that hold the
 * same account, two that hold different accounts under one id, and two that hold
 * the owner layer — which every contract-2 profile did, written from a fixed
 * table, and which is therefore the collision every real migration hits.
 */

const homes: string[] = [];

async function workspace(profiles: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-c3-'));
  homes.push(root);

  await writeFile(
    join(root, 'lanes-link.yaml'),
    'contract: 2\ntargets:\n  local:\n    credentials: { adapter: file }\n    storage: { adapter: filesystem }\n',
  );
  await mkdir(join(root, 'profiles'), { recursive: true });
  for (const [name, body] of Object.entries(profiles)) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), body);
  }
  return root;
}

/** A contract-2 profile: the owner layer every one of them carried, plus extras. */
function legacy(options: {
  profile: string;
  connections?: string;
  allow?: string;
  deny?: string;
}): string {
  return [
    'contract: 2',
    `instance: { profile: ${options.profile}, port: 7337 }`,
    'connections:',
    '  - { id: main, provider: memory, account: Memory }',
    '  - { id: main, provider: vault, account: Vault }',
    options.connections ?? '',
    'policy:',
    `  allow: [${options.allow ?? "'*'"}]`,
    `  deny: [${options.deny ?? ''}]`,
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function readYaml(root: string, path: string): Promise<Record<string, unknown>> {
  return parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>;
}

/** Every connection ref the workspace ended up with. */
async function refs(root: string): Promise<string[]> {
  const file = await readYaml(root, 'connections.yaml');
  const rows = (file['connections'] ?? []) as { provider: string; id: string }[];
  return rows.map((row) => `${row.provider}.${row.id}`).sort();
}

afterAll(async () => {
  await Promise.all(homes.map((one) => rm(one, { recursive: true, force: true })));
});

describe('the owner layer', () => {
  test('is never merged between profiles', async () => {
    // The defect this test exists for. Every contract-2 profile carried an
    // identical owner layer from a fixed table, so keying the hoist on
    // provider-plus-account made all of them collide and merge — which is the
    // one outcome ADR-059 forbids, because interleaving two sets of notes is not
    // reversible and for the vault the wrong answer is a credential.
    const root = await workspace({
      personal: legacy({ profile: 'personal' }),
      work: legacy({ profile: 'work' }),
    });

    await migrateToContract3(root);

    expect(await refs(root)).toEqual(['memory.main', 'memory.work', 'vault.main', 'vault.work']);
  });

  test('takes the profile name, not a number', async () => {
    // ADR-059 specifies `memory.<profile>`, and it reads far better than
    // `memory.main_2` when the thing being separated is "work's notes".
    const root = await workspace({
      personal: legacy({ profile: 'personal' }),
      work: legacy({ profile: 'work' }),
    });

    const result = await migrateToContract3(root);

    expect(result.renames.map((one) => one.to)).toContain('memory.work');
  });

  test('each profile grants its own instance and no other', async () => {
    const root = await workspace({
      personal: legacy({ profile: 'personal' }),
      work: legacy({ profile: 'work' }),
    });

    await migrateToContract3(root);

    const work = await readYaml(root, 'profiles/work.yaml');
    const granted = ((work['grants'] ?? []) as { connection: string }[]).map(
      (one) => one.connection,
    );

    expect(granted).toContain('memory.work');
    expect(granted).not.toContain('memory.main');
  });
});

describe('two profiles holding one provider', () => {
  test('the same account is one connection', async () => {
    // The merge that *is* correct: one mailbox authorised twice is one mailbox.
    const root = await workspace({
      personal: legacy({
        profile: 'personal',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
      }),
      work: legacy({
        profile: 'work',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
      }),
    });

    await migrateToContract3(root);

    expect(await refs(root)).toContain('gmail.main');
    expect((await refs(root)).filter((ref) => ref.startsWith('gmail.'))).toHaveLength(1);
  });

  test('different accounts under one id are two connections', async () => {
    const root = await workspace({
      personal: legacy({
        profile: 'personal',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
      }),
      work: legacy({
        profile: 'work',
        connections: '  - { id: main, provider: gmail, account: rin@example.com }',
      }),
    });

    await migrateToContract3(root);
    const gmail = (await refs(root)).filter((ref) => ref.startsWith('gmail.'));

    expect(gmail).toHaveLength(2);
  });
});

describe('a rule that had an expiry', () => {
  test('one that has lapsed is dropped rather than made permanent', async () => {
    // `isRuleActive` is what made a lapsed rule inert. Reading the capability
    // and discarding `expires_at` turned an allow that died months ago into a
    // live permanent grant.
    const root = await workspace({
      personal: legacy({
        profile: 'personal',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
        allow: "{ capability: 'gmail.*', expires_at: '2020-01-01T00:00:00Z' }",
      }),
    });

    await migrateToContract3(root);
    const config = await readYaml(root, 'profiles/personal.yaml');
    const gmail = ((config['grants'] ?? []) as { connection: string; allow: unknown[] }[]).find(
      (one) => one.connection === 'gmail.main',
    );

    expect(gmail?.allow).toEqual([]);
  });

  test('one still in force keeps its expiry', async () => {
    const root = await workspace({
      personal: legacy({
        profile: 'personal',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
        allow: "{ capability: 'gmail.*', expires_at: '2099-01-01T00:00:00Z' }",
      }),
    });

    await migrateToContract3(root);
    const config = await readYaml(root, 'profiles/personal.yaml');
    const gmail = ((config['grants'] ?? []) as { connection: string; allow: unknown[] }[]).find(
      (one) => one.connection === 'gmail.main',
    );

    expect(gmail?.allow).toEqual([
      { capability: 'gmail.*', expires_at: '2099-01-01T00:00:00Z' },
    ]);
  });

  test('an expired deny is dropped too, which is not the safe-looking direction', async () => {
    // Carrying it forward would make it permanent, and a deny outranks every
    // allow unconditionally.
    const root = await workspace({
      personal: legacy({
        profile: 'personal',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
        deny: "{ capability: 'gmail.users.drafts.send', expires_at: '2020-01-01T00:00:00Z' }",
      }),
    });

    await migrateToContract3(root);
    const config = await readYaml(root, 'profiles/personal.yaml');
    const gmail = ((config['grants'] ?? []) as { connection: string; deny: unknown[] }[]).find(
      (one) => one.connection === 'gmail.main',
    );

    expect(gmail?.deny).toEqual([]);
  });
});

describe('the registry', () => {
  test('is stamped, renamed, and given a default', async () => {
    const root = await workspace({ personal: legacy({ profile: 'personal' }) });

    await migrateToContract3(root);
    const registry = await readYaml(root, 'lanes-link.yaml');

    expect(registry['contract']).toBe(3);
    expect(registry['workspaces']).toBeDefined();
    expect(registry['targets']).toBeUndefined();
    expect(registry['default_workspace']).toBe('local');
  });

  test('is written first, so an interrupted run leaves a workspace that opens', async () => {
    // The registry is the one step that is not idempotent — it reads `targets:`
    // and finds none the second time. Running it last meant an interruption
    // anywhere before it left profiles at contract 3 and the registry at
    // contract 2, which re-entry read as nothing to do and every command read as
    // "declares no workspace".
    const source = await readFile(join(import.meta.dir, 'contract3.ts'), 'utf8');
    const apply = source.slice(source.indexOf('if (!options.apply) return result;'));

    expect(apply.indexOf('rewriteRegistry')).toBeLessThan(apply.indexOf('writeConnections'));
  });
});

describe('running it again', () => {
  test('is a no-op rather than a second migration', async () => {
    const root = await workspace({
      personal: legacy({
        profile: 'personal',
        connections: '  - { id: main, provider: gmail, account: ada@example.com }',
      }),
    });

    await migrateToContract3(root);
    const before = await refs(root);
    const second = await migrateToContract3(root);

    expect(second.alreadyCurrent).toBe(true);
    expect(await refs(root)).toEqual(before);
  });
});
