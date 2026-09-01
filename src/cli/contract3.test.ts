import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { migrateToContract3 } from './contract3.ts';
import { migrateToCurrentContract } from './workspace-migrate.ts';
import { applyMoves, planCredentials, planMoves } from './contract3-data.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';

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

describe('reaching the current contract, the way deploy does', () => {
  /**
   * The gap this covers was not a refusal, which is why it survived.
   *
   * `deploy` and `doctor --fix` ran the contract 1→2 step and stopped, so a
   * contract-2 bucket went through untouched: the config was replaced with
   * contract-3 YAML and the bytes stayed under `data/<profile>/`. The revision
   * came up healthy reading an empty `data/`, and an empty audit chain verifies
   * as intact. Nothing anywhere said a word.
   */
  test('a contract-2 workspace arrives at contract 3', async () => {
    const root = await workspace({ personal: legacy({ profile: 'personal' }) });

    const migration = await migrateToCurrentContract(root, {
      apply: true,
      subject: 'lanes:somebody',
    });

    expect(migration.alreadyCurrent).toBe(false);
    expect(migration.contract3).not.toBeNull();
    expect(migration.profiles).toEqual(['personal']);

    expect((await readYaml(root, 'profiles/personal.yaml'))['contract']).toBe(3);

    const registry = await readYaml(root, 'lanes-link.yaml');
    expect(registry['contract']).toBe(3);
    expect(registry['workspaces']).toBeDefined();
    expect(registry['targets']).toBeUndefined();
  });

  test('a second run finds nothing to do', async () => {
    const root = await workspace({ personal: legacy({ profile: 'personal' }) });
    const options = { apply: true, subject: 'lanes:somebody' };

    await migrateToCurrentContract(root, options);
    const again = await migrateToCurrentContract(root, options);

    expect(again.alreadyCurrent).toBe(true);
    expect(again.changes).toEqual([]);
  });
});

describe('moving the bytes', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test('an interrupted move is finished rather than refused', async () => {
    // Copy-then-delete has a window between the two, and this now runs against
    // buckets where that window is a network round trip. Refusing here would
    // mean a workspace that cannot be migrated by running the migration again,
    // which is the one recovery this migration promises.
    const files = createMemoryBlobStore();
    await files.put('data/personal/memory/main/a.md', bytes('note'));
    await files.put('data/memory/main/a.md', bytes('note'));

    await applyMoves(files, [
      { from: 'data/personal/memory/main/a.md', to: 'data/memory/main/a.md' },
    ]);

    expect(await files.has('data/personal/memory/main/a.md')).toBe(false);
    expect(await files.get('data/memory/main/a.md')).toEqual(bytes('note'));
  });

  test('different bytes at the destination refuse, and delete nothing', async () => {
    const files = createMemoryBlobStore();
    await files.put('data/personal/memory/main/a.md', bytes('mine'));
    await files.put('data/memory/main/a.md', bytes('somebody else\u2019s'));

    await expect(
      applyMoves(files, [{ from: 'data/personal/memory/main/a.md', to: 'data/memory/main/a.md' }]),
    ).rejects.toThrow(/cannot merge them/);

    expect(await files.has('data/personal/memory/main/a.md')).toBe(true);
  });

  test('two objects aimed at one key refuse while this is still a plan', async () => {
    // The per-object check cannot see this one once the moves run concurrently:
    // both would look at an absent destination and both would write.
    const files = createMemoryBlobStore();
    await files.put('data/personal/memory/main/a.md', bytes('one'));
    await files.put('data/work/memory/main/a.md', bytes('two'));

    const collide = new Map([
      ['personal', new Map([['memory.main', 'memory.main']])],
      ['work', new Map([['memory.main', 'memory.main']])],
    ]);

    await expect(planMoves(files, ['personal', 'work'], collide)).rejects.toThrow(
      /cannot merge them/,
    );
    expect(await files.has('data/personal/memory/main/a.md')).toBe(true);
    expect(await files.has('data/work/memory/main/a.md')).toBe(true);
  });
});

describe('a workspace in a bucket', () => {
  test('has no per-profile credential stores to merge', async () => {
    // `workspacePath` refuses a filesystem credential adapter against a remote
    // root, so the only store such a workspace can declare is Secret Manager —
    // whose refs were never scoped by profile. Without the guard this built
    // `gs://.../data/personal/credentials.enc`, handed it to `Bun.file`, and let
    // the catch report an empty list, which is the same answer for the wrong
    // reason and would have hidden a real store that would not open.
    expect(await planCredentials('gs://your-bucket', ['personal'])).toEqual([]);
  });
});

describe('the contract stamp is the record that this finished', () => {
  test('a move that fails leaves the profile at contract 2, so a re-run retries', async () => {
    // `needsContract3` reads nothing but the stamp, so writing it before the
    // bytes had moved turned any interruption into silent data loss: the re-run
    // saw contract 3 and did nothing, and every object stayed under
    // `data/<profile>/` where the contract-3 reader does not look.
    //
    // The failure is induced with an occupied destination, which is the one
    // thing `applyMoves` refuses part-way through.
    const root = await workspace({ personal: legacy({ profile: 'personal' }) });

    await mkdir(join(root, 'data', 'personal', 'memory', 'main'), { recursive: true });
    await writeFile(join(root, 'data', 'personal', 'memory', 'main', 'a.md'), 'mine');
    await mkdir(join(root, 'data', 'memory', 'main'), { recursive: true });
    await writeFile(join(root, 'data', 'memory', 'main', 'a.md'), 'not a copy of it');

    await expect(migrateToContract3(root)).rejects.toThrow(/cannot merge them/);

    expect((await readYaml(root, 'profiles/personal.yaml'))['contract']).toBe(2);
    expect(await readFile(join(root, 'data', 'personal', 'memory', 'main', 'a.md'), 'utf8')).toBe(
      'mine',
    );
  });
});
