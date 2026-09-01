import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { migrateToContract3 } from './contract3.ts';
import { migrateToCurrentContract } from './workspace-migrate.ts';
import { applyMoves, planMoves } from './contract3-data.ts';
import { planCredentials } from './contract3-credentials.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { createFileSecretStore } from '#secrets';
import { objectKey } from '#stores/state';

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
    const plan = { profile: 'personal', renames: new Map(), tokenRef: 'profile/token' };
    expect(await planCredentials('gs://your-bucket', [plan])).toEqual({ refs: [], tokens: [] });
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

describe('state.kv', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const record = (provider: string, id: string) =>
    bytes(JSON.stringify({ provider, id, status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }));
  const under = (profile: string, namespace: string, key: string) =>
    `data/${profile}/state.kv/${objectKey(namespace, key)}`;
  const hoisted = (namespace: string, key: string) =>
    `data/state.kv/${objectKey(namespace, key)}`;

  async function body(files: ReturnType<typeof createMemoryBlobStore>, key: string) {
    const raw = await files.get(key);
    return raw === null ? null : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  }

  test('a renamed connection takes its record with it, key and body', async () => {
    // The defect this whole file was reopened for. `state.kv` was moved
    // verbatim on the grounds that its records "already carry the profile" —
    // but `connections.v1` is keyed on `<provider>.<id>`, which is exactly what
    // the hoist renames, so every profile's owner layer aimed an object at
    // `connections.v1/vault.main` and the migration refused.
    //
    // The body matters as much as the key: `ConnectionRepository.list` reads
    // `provider` and `id` out of the record, so a verbatim copy would sit at
    // `vault.work` still calling itself `vault.main`.
    const files = createMemoryBlobStore();
    await files.put(under('personal', 'connections.v1', 'vault.main'), record('vault', 'main'));
    await files.put(under('work', 'connections.v1', 'vault.main'), record('vault', 'main'));

    const moves = await planMoves(
      files,
      ['personal', 'work'],
      new Map([
        ['personal', new Map([['vault.main', 'vault.main']])],
        ['work', new Map([['vault.main', 'vault.work']])],
      ]),
    );
    await applyMoves(files, moves);

    expect(await body(files, hoisted('connections.v1', 'vault.main'))).toMatchObject({
      provider: 'vault',
      id: 'main',
    });
    expect(await body(files, hoisted('connections.v1', 'vault.work'))).toMatchObject({
      provider: 'vault',
      id: 'work',
    });
    // Everything else the record carried survives the retarget.
    expect(await body(files, hoisted('connections.v1', 'vault.work'))).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await files.has(under('work', 'connections.v1', 'vault.main'))).toBe(false);
  });

  test('a record for a connection the profile no longer declares is left where it is', async () => {
    // No row means the hoist never saw it, so there is nothing to map it to.
    // Moving it anyway would manufacture a connection that nothing grants and
    // no credential backs — and its key can collide with a rename that is real.
    const files = createMemoryBlobStore();
    await files.put(under('personal', 'connections.v1', 'tasks.main'), record('tasks', 'main'));
    await files.put(under('personal', 'connections.v1', 'gmail.old'), record('gmail', 'old'));

    const moves = await planMoves(
      files,
      ['personal'],
      new Map([['personal', new Map([['tasks.main', 'tasks.personal']])]]),
    );
    await applyMoves(files, moves);

    expect(await files.has(hoisted('connections.v1', 'tasks.personal'))).toBe(true);
    expect(await files.has(hoisted('connections.v1', 'gmail.old'))).toBe(false);
    // Left, not deleted. Nothing this migration does not understand is lost.
    expect(await files.has(under('personal', 'connections.v1', 'gmail.old'))).toBe(true);
  });

  test('two profiles that share one account keep one record between them', async () => {
    // Same provider, same account: the hoist merges them into one row, so both
    // profiles map to the same key and both hold a record describing it. One
    // connection, one record — this is a duplicate, not a collision.
    const files = createMemoryBlobStore();
    await files.put(under('personal', 'connections.v1', 'gmail.main'), record('gmail', 'main'));
    await files.put(under('work', 'connections.v1', 'gmail.main'), record('gmail', 'main'));

    const shared = new Map([
      ['personal', new Map([['gmail.main', 'gmail.main']])],
      ['work', new Map([['gmail.main', 'gmail.main']])],
    ]);

    await applyMoves(files, await planMoves(files, ['personal', 'work'], shared));

    expect(await files.has(hoisted('connections.v1', 'gmail.main'))).toBe(true);
    expect(await files.has(under('work', 'connections.v1', 'gmail.main'))).toBe(true);
  });

  test('the discovery cache is keyed on the provider, so the first profile wins', async () => {
    // Not per connection: `open.ts` reads it by manifest id, and a miss or a
    // corrupt entry both mean "not discovered yet", which `connect` refreshes.
    const files = createMemoryBlobStore();
    await files.put(under('personal', 'discovery', 'gmail'), bytes('["personal"]'));
    await files.put(under('work', 'discovery', 'gmail'), bytes('["work"]'));

    await applyMoves(files, await planMoves(files, ['personal', 'work'], new Map()));

    expect(await files.get(hoisted('discovery', 'gmail'))).toEqual(bytes('["personal"]'));
    expect(await files.has(under('work', 'discovery', 'gmail'))).toBe(true);
  });

  test('the audit log is still concatenated object by object', async () => {
    // One object per event under a key that already carries the timestamp, so
    // three profiles' logs merge by moving them and nothing collides.
    const files = createMemoryBlobStore();
    await files.put('data/personal/audit.log/2026/01/a.json', bytes('one'));
    await files.put('data/work/audit.log/2026/01/b.json', bytes('two'));

    await applyMoves(files, await planMoves(files, ['personal', 'work'], new Map()));

    expect(await files.get('data/audit.log/2026/01/a.json')).toEqual(bytes('one'));
    expect(await files.get('data/audit.log/2026/01/b.json')).toEqual(bytes('two'));
  });
});

describe('merging credentials', () => {
  async function credentials(root: string, profile: string) {
    await mkdir(join(root, 'data', profile), { recursive: true });
    return createFileSecretStore({ path: join(root, 'data', profile, 'credentials.enc') });
  }

  const withGithub = (profile: string, account: string) =>
    legacy({
      profile,
      connections: `  - { id: main, provider: github, account: ${account} }`,
    });

  test("a renamed connection's credential ref follows the rename", async () => {
    // `credentialRefForConnection` derives `<provider>/<id>`, and the hoist
    // renamed the connection with `{ ...connection, id }` — leaving the derived
    // ref behind. Two profiles then claimed `github/main` with two different
    // tokens, which aborted the migration on a rename it had just made itself.
    const root = await workspace({
      personal: withGithub('personal', 'example-org'),
      work: withGithub('work', 'example-user'),
    });

    await (await credentials(root, 'personal')).set('github/main', 'token-for-org');
    await (await credentials(root, 'work')).set('github/main', 'token-for-user');

    await migrateToContract3(root, { apply: true });

    expect(await refs(root)).toContain('github.main');
    expect(await refs(root)).toContain('github.main_2');

    const merged = createFileSecretStore({ path: join(root, 'data', 'credentials.enc') });
    expect(await merged.get('github/main')).toBe('token-for-org');
    expect(await merged.get('github/main_2')).toBe('token-for-user');
  });

  test('the endpoint token is left behind rather than picked between', async () => {
    // Every profile keeps it under one ref because the schema defaults
    // `token_ref` to `profile/token`. One store now, so three profiles are
    // three values for one key and no merge means anything. It is minted
    // locally, `ensureProfileToken` writes a fresh one on the next command, and
    // the old stores are not deleted — so nothing has to be authorised again.
    const root = await workspace({
      personal: legacy({ profile: 'personal' }),
      work: legacy({ profile: 'work' }),
    });

    await (await credentials(root, 'personal')).set('profile/token', 'llk_personal');
    await (await credentials(root, 'work')).set('profile/token', 'llk_work');

    const migration = await migrateToContract3(root, { apply: true });

    const merged = createFileSecretStore({ path: join(root, 'data', 'credentials.enc') });
    expect(await merged.get('profile/token')).toBe(null);
    expect(migration.changes.join('\n')).toContain('profile/token');
    // Not deleted: the old store is the only copy, and it stays one.
    expect(await (await credentials(root, 'personal')).get('profile/token')).toBe('llk_personal');
  });

  test('two profiles sharing one account keep one credential between them', async () => {
    // Same provider and account, so `hoistConnections` merges them into a single
    // row — and a single row has a single credential. This used to refuse with
    // "Two profiles hold different values", which was a refusal on a merge the
    // migration had just performed itself.
    const root = await workspace({
      personal: withGithub('personal', 'example-org'),
      work: withGithub('work', 'example-org'),
    });

    await (await credentials(root, 'personal')).set('github/main', 'one');
    await (await credentials(root, 'work')).set('github/main', 'two');

    await migrateToContract3(root, { apply: true });

    expect((await refs(root)).filter((key) => key.startsWith('github.'))).toEqual(['github.main']);
    const merged = createFileSecretStore({ path: join(root, 'data', 'credentials.enc') });
    expect(await merged.get('github/main')).toBe('one');
  });

  test('a credential neither connection owns refuses before anything is written', async () => {
    // An OAuth *client* is registered per profile and stored under a ref keyed
    // on the app, not on a connection — so no rename can separate two of them
    // and there is nothing to merge. Both are real, and this must not pick.
    //
    // The refusal has to land in the plan: it used to throw from
    // `mergeCredentials`, by which point `rewriteRegistry` had already stamped
    // the workspace at contract 3.
    const root = await workspace({
      personal: legacy({ profile: 'personal' }),
      work: legacy({ profile: 'work' }),
    });

    await (await credentials(root, 'personal')).set('google/client_id', 'one');
    await (await credentials(root, 'work')).set('google/client_id', 'two');

    await expect(migrateToContract3(root, { apply: true })).rejects.toThrow(
      /cannot choose between them/,
    );

    expect((await readYaml(root, 'lanes-link.yaml'))['contract']).toBe(2);
    expect((await readYaml(root, 'profiles/personal.yaml'))['contract']).toBe(2);
  });

  test('the preview reports the same refs the apply writes', async () => {
    const root = await workspace({ personal: legacy({ profile: 'personal' }) });
    await (await credentials(root, 'personal')).set('memory/main', 'value');
    await (await credentials(root, 'personal')).set('profile/token', 'llk_one');

    const preview = await migrateToContract3(root, { apply: false });
    // `profile/token` among them: one profile cannot disagree with itself, so
    // there is nothing to leave behind and dropping it would have logged every
    // client out for a conflict that does not exist.
    expect(preview.credentials).toEqual(['memory/main', 'profile/token']);

    await migrateToContract3(root, { apply: true });
    const merged = createFileSecretStore({ path: join(root, 'data', 'credentials.enc') });
    expect(await merged.get('memory/main')).toBe('value');
  });
});

describe('the sticky default workspace', () => {
  test('is the one on this machine, not whichever key sorts first', async () => {
    // The registry is written sorted, so a workspace that had ever deployed
    // came out of the 1-to-2 migration with `cloud` ahead of `local`. Taking
    // the first key then pointed every command at a bucket, and a bucket is the
    // one kind of workspace that can be unreachable — the next `status`
    // answered with a 403 instead of the profiles sitting on the disk.
    const root = await mkdtemp(join(tmpdir(), 'lanes-c3-'));
    homes.push(root);

    await writeFile(
      join(root, 'lanes-link.yaml'),
      [
        'contract: 2',
        'targets:',
        '  cloud:',
        '    workspace: gs://your-bucket',
        '  local:',
        '    credentials: { adapter: file }',
        '    storage: { adapter: filesystem }',
        '',
      ].join('\n'),
    );
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal.yaml'), legacy({ profile: 'personal' }));

    await migrateToContract3(root, { apply: true });

    expect((await readYaml(root, 'lanes-link.yaml'))['default_workspace']).toBe('local');
  });

  test('falls back to the first when every workspace is a pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-c3-'));
    homes.push(root);

    await writeFile(
      join(root, 'lanes-link.yaml'),
      'contract: 2\ntargets:\n  cloud:\n    workspace: gs://your-bucket\n',
    );
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal.yaml'), legacy({ profile: 'personal' }));

    await migrateToContract3(root, { apply: true });

    expect((await readYaml(root, 'lanes-link.yaml'))['default_workspace']).toBe('cloud');
  });
});

describe('a registry carrying both blocks', () => {
  test('the newer workspaces: entry survives, rather than being rebuilt from stale targets:', async () => {
    // What `editRegistry` used to leave behind: a deploy recorded into a
    // contract-2 file wrote `workspaces:` without touching `targets:`, so the
    // two disagreed. Rebuilding `workspaces:` from `targets:` then reverted a
    // recorded deployment to whatever the last contract-2 command had written,
    // silently — which is how a deploy that had genuinely happened came to read
    // as a version older than the one serving it.
    //
    // Same rule the 1-to-2 migration states: anything already in the file wins
    // over what is re-derived, because a workspace part way through this has
    // entries that are already right.
    const root = await mkdtemp(join(tmpdir(), 'lanes-c3-'));
    homes.push(root);

    await writeFile(
      join(root, 'lanes-link.yaml'),
      [
        'contract: 2',
        'targets:',
        '  cloud:',
        '    workspace: gs://your-bucket',
        '    last_deploy_version: 0.7.2',
        '  local:',
        '    credentials: { adapter: file }',
        '    storage: { adapter: filesystem }',
        'workspaces:',
        '  cloud:',
        '    at: gs://your-bucket',
        '    last_deploy_version: 0.8.0',
        '',
      ].join('\n'),
    );
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal.yaml'), legacy({ profile: 'personal' }));

    await migrateToContract3(root, { apply: true });

    const registry = (await readYaml(root, 'lanes-link.yaml')) as {
      targets?: unknown;
      workspaces?: Record<string, { last_deploy_version?: string; at?: string }>;
    };

    expect(registry.targets).toBeUndefined();
    expect(registry.workspaces?.['cloud']?.last_deploy_version).toBe('0.8.0');
    // And the entry only `targets:` knew about is still carried across.
    expect(registry.workspaces?.['local']).toBeDefined();
  });
});

describe('running the migration again after it was interrupted', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const under = (profile: string, namespace: string, key: string) =>
    `data/${profile}/state.kv/${objectKey(namespace, key)}`;

  test('a shared connection\'s duplicate does not wedge the rerun', async () => {
    // `claim` drops the loser within one run, but the winner's source is deleted
    // and the loser's is not — so the rerun saw a different first claimant,
    // found the destination holding somebody else's bytes, and threw. Every
    // subsequent run reproduced it, and `rewriteProfiles` stamps the contract
    // *after* the moves, so an interruption during them forces exactly this.
    const files = createMemoryBlobStore();
    await files.put(under('personal', 'connections.v1', 'gmail.main'), bytes('{"id":"main","u":"A"}'));
    await files.put(under('work', 'connections.v1', 'gmail.main'), bytes('{"id":"main","u":"B"}'));

    const shared = new Map([
      ['personal', new Map([['gmail.main', 'gmail.main']])],
      ['work', new Map([['gmail.main', 'gmail.main']])],
    ]);

    for (let run = 0; run < 3; run += 1) {
      await applyMoves(files, await planMoves(files, ['personal', 'work'], shared));
    }

    expect(await files.has(`data/state.kv/${objectKey('connections.v1', 'gmail.main')}`)).toBe(true);
  });

  test("a provider's own state follows the connection rename, like its blobs do", async () => {
    // `state.kv/<provider>/<connection>` is keyed on the connection exactly as
    // `data/<provider>/<connection>/` is. Left out of the first pass, so two
    // profiles holding one provider's fixed-name object — `dav`'s home,
    // `bunq`'s session — still aimed at one key.
    const files = createMemoryBlobStore();
    await files.put(under('personal', 'icloud_mail/main', 'dav.home'), bytes('home-personal'));
    await files.put(under('work', 'icloud_mail/main', 'dav.home'), bytes('home-work'));

    await applyMoves(
      files,
      await planMoves(
        files,
        ['personal', 'work'],
        new Map([
          ['personal', new Map([['icloud_mail.main', 'icloud_mail.main']])],
          ['work', new Map([['icloud_mail.main', 'icloud_mail.work']])],
        ]),
      ),
    );

    expect(await files.get(`data/state.kv/${objectKey('icloud_mail/main', 'dav.home')}`)).toEqual(
      bytes('home-personal'),
    );
    expect(await files.get(`data/state.kv/${objectKey('icloud_mail/work', 'dav.home')}`)).toEqual(
      bytes('home-work'),
    );
  });

  test('one custom manifest held by two profiles is a duplicate, not a refusal', async () => {
    // Under ADR-030 a manifest lived in the profile, so an operator using their
    // own connector in two profiles has two copies of one file.
    const files = createMemoryBlobStore();
    await files.put('data/personal/providers.d/mything.yaml', bytes('id: mything'));
    await files.put('data/work/providers.d/mything.yaml', bytes('id: mything'));

    await applyMoves(files, await planMoves(files, ['personal', 'work'], new Map()));

    expect(await files.get('data/providers.d/mything.yaml')).toEqual(bytes('id: mything'));
  });
});

describe('the registry a half-recorded deploy left behind', () => {
  test('a field only the stale targets: entry carries is not dropped', async () => {
    // Merging per entry rather than per field discarded `primary` — which
    // schema.ts calls the one question about a deployment that must not be
    // guessed at — along with `last_deploy` and the `deploy:` block naming the
    // project and region. Preserving the record is the whole point of the merge.
    const root = await mkdtemp(join(tmpdir(), 'lanes-c3-'));
    homes.push(root);

    await writeFile(
      join(root, 'lanes-link.yaml'),
      [
        'contract: 2',
        'targets:',
        '  cloud:',
        '    workspace: gs://your-bucket',
        '    primary: personal',
        '    last_deploy_version: 0.7.2',
        'workspaces:',
        '  cloud:',
        '    at: gs://your-bucket',
        '    last_deploy_version: 0.8.0',
        '',
      ].join('\n'),
    );
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal.yaml'), legacy({ profile: 'personal' }));

    await migrateToContract3(root, { apply: true });

    const cloud = (
      (await readYaml(root, 'lanes-link.yaml')) as {
        workspaces?: Record<string, { primary?: string; last_deploy_version?: string }>;
      }
    ).workspaces?.['cloud'];

    expect(cloud?.last_deploy_version).toBe('0.8.0');
    expect(cloud?.primary).toBe('personal');
  });

  test('a cloud target surveyed but never rolled out is not made the default', async () => {
    // `bootstrap` writes the surveyed adapters into the local registry before
    // the rollout, and only `recordDeployment` later replaces them with a
    // pointer. A deploy that failed at build or IAM therefore leaves a *declared*
    // cloud entry with no `at:` — so reading "no at:" as "on this machine" chose
    // the bucket, which is the 403 this was written to prevent.
    const root = await mkdtemp(join(tmpdir(), 'lanes-c3-'));
    homes.push(root);

    await writeFile(
      join(root, 'lanes-link.yaml'),
      [
        'contract: 2',
        'targets:',
        '  cloud:',
        '    credentials: { adapter: gcp-secret-manager, project: my-project }',
        '    storage: { adapter: gcs, bucket: your-bucket }',
        '  local:',
        '    credentials: { adapter: file }',
        '    storage: { adapter: filesystem }',
        '',
      ].join('\n'),
    );
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal.yaml'), legacy({ profile: 'personal' }));

    await migrateToContract3(root, { apply: true });

    expect((await readYaml(root, 'lanes-link.yaml'))['default_workspace']).toBe('local');
  });
});
