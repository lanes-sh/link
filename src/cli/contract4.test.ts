import { SUPPORTED_CONTRACT } from '#profile';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { migrateToContract4, needsContract4 } from './contract4.ts';

/**
 * Contract 3 to contract 4, against a real workspace on disk.
 *
 * Written against outcomes rather than internals — what is on disk afterwards —
 * because that is what the last two migrations' defects had in common: three of
 * the four found by review lost, leaked or misrouted data *while reporting
 * success*.
 *
 * The fixture is the shape a real workspace is actually in. Contract 3's
 * template grants every profile the same `.main` instances, so a two-profile
 * workspace has two profiles pointing at one memory — the case that has no
 * answer right for everyone, and the one this migration must not guess at.
 */

const homes: string[] = [];

const PROFILE = (name: string, grants: readonly string[]): string =>
  `contract: 3\ninstance:\n  profile: ${name}\ngrants:\n` +
  grants.map((ref) => `  - { connection: ${ref}, allow: ['${ref.split('.')[0]}.*'] }\n`).join('') +
  'members: []\n';

async function workspace(
  profiles: Record<string, readonly string[]>,
  data: Record<string, string> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-c4-'));
  homes.push(root);

  await writeFile(
    join(root, 'lanes-link.yaml'),
    'contract: 3\nworkspaces:\n  local:\n    credentials: { adapter: file }\n    storage: { adapter: filesystem }\n',
  );
  // Declared from the grants, so the fixture is a workspace that actually
  // loads: a grant naming a connection the workspace does not hold is refused
  // by `assertGrantsResolve` (ADR-057), and a fixture that could not load would
  // be testing the migration against a state no operator can be in.
  const declared = [...new Set(Object.values(profiles).flat())].map((ref) => {
    const [provider, id] = ref.split('.');
    return `  - { id: ${id}, provider: ${provider}, account: ${provider} }`;
  });
  await writeFile(
    join(root, 'connections.yaml'),
    `contract: 3\nconnections:\n${declared.join('\n')}\noauth_apps: {}\n`,
  );

  await mkdir(join(root, 'profiles'), { recursive: true });
  for (const [name, grants] of Object.entries(profiles)) {
    await writeFile(join(root, 'profiles', `${name}.yaml`), PROFILE(name, grants));
  }

  for (const [key, body] of Object.entries(data)) {
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), body);
  }

  return root;
}

const read = (root: string, key: string): Promise<string> => readFile(join(root, key), 'utf8');
const has = (root: string, key: string): boolean => existsSync(join(root, key));

afterAll(async () => {
  await Promise.all(homes.map((root) => rm(root, { recursive: true, force: true })));
});

describe('what contract 4 moves', () => {
  test('the workspace keeps four stores, out of data/ and up to the root', async () => {
    const root = await workspace(
      { personal: ['memory.main'] },
      {
        'data/credentials.enc': 'ciphertext',
        'data/credentials.enc.key': 'the key',
        'data/providers.d/acme.yaml': 'id: acme\n',
        'data/audit.log/2026/08/24/x.json': '{}',
        'data/state.kv/connections%2Ev1/memory%2Elan1.json': '{}',
      },
    );

    await migrateToContract4(root);

    expect(await read(root, 'credentials.enc')).toBe('ciphertext');
    expect(await read(root, 'credentials.enc.key')).toBe('the key');
    expect(await read(root, 'providers.d/acme.yaml')).toBe('id: acme\n');
    expect(has(root, 'audit.log/2026/08/24/x.json')).toBe(true);
    expect(has(root, 'state.kv/connections%2Ev1/memory%2Elan1.json')).toBe(true);

    // Not left behind as well as copied: these are moves.
    expect(has(root, 'data/credentials.enc')).toBe(false);
  });

  test('a store one profile grants moves into that profile', async () => {
    const root = await workspace(
      { personal: ['memory.main'], work: ['memory.other'] },
      {
        'data/memory/main/a-note.md': 'personal',
        'data/memory/other/b-note.md': 'work',
      },
    );

    await migrateToContract4(root);

    expect(await read(root, 'profiles/personal/memory/lan1/a-note.md')).toBe('personal');
    expect(await read(root, 'profiles/work/memory/lan2/b-note.md')).toBe('work');
    expect(has(root, 'data/memory/main/a-note.md')).toBe(false);
  });

  test('a store two profiles grant is copied into each, and the original is left', async () => {
    // The case with no right answer, and the one contract 3's own template
    // produces. Moving it into one profile takes it from the other; merging two
    // sets of notes is not reversible. So both get a copy and the operator is
    // told what to delete.
    const root = await workspace(
      { personal: ['memory.main'], work: ['memory.main'] },
      { 'data/memory/main/shared.md': 'a note' },
    );

    const migration = await migrateToContract4(root);

    expect(await read(root, 'profiles/personal/memory/lan1/shared.md')).toBe('a note');
    expect(await read(root, 'profiles/work/memory/lan1/shared.md')).toBe('a note');
    expect(has(root, 'data/memory/main/shared.md')).toBe(true);

    expect(migration.shared).toEqual([
      { key: 'data/memory/main/shared.md', profiles: ['personal', 'work'] },
    ]);
    expect(migration.changes.join('\n')).toContain('copied into personal and work');
  });

  test('a store nobody grants is left where it is, and named', async () => {
    const root = await workspace(
      { personal: ['memory.main'] },
      { 'data/memory/orphan/note.md': 'nobody granted this' },
    );

    const migration = await migrateToContract4(root);

    expect(has(root, 'data/memory/orphan/note.md')).toBe(true);
    expect(migration.orphaned).toEqual(['data/memory/orphan/note.md']);
    expect(migration.changes.join('\n')).toContain('no profile grants it');
  });

  test("a profile's vault and skills follow it, keyed by the connection", async () => {
    const root = await workspace(
      { personal: ['vault.main', 'skills.main'] },
      {
        'data/vault.d/main.enc': 'sealed',
        'data/vault.d/main.enc.key': 'its key',
        'data/skills.d/main/triage/SKILL.md': '---\ndescription: d\n---\nb\n',
      },
    );

    await migrateToContract4(root);

    expect(await read(root, 'profiles/personal/vault.d/lan1.enc')).toBe('sealed');
    expect(await read(root, 'profiles/personal/vault.d/lan1.enc.key')).toBe('its key');
    expect(has(root, 'profiles/personal/skills.d/lan2/triage/SKILL.md')).toBe(true);
  });

  test('state splits by what a key is about, not by who reads it', async () => {
    const root = await workspace(
      { personal: ['memory.main'] },
      {
        // The workspace's: a connection record and this endpoint's OAuth server.
        'data/state.kv/connections%2Ev1/memory%2Elan1.json': '{}',
        'data/state.kv/oauth%2Ev1/clients/abc.json': '{}',
        // The profile's: a cursor, keyed by the connection it belongs to.
        'data/state.kv/cursors%2Ev1/memory%2Emain.json': '"a cursor"',
      },
    );

    await migrateToContract4(root);

    expect(has(root, 'state.kv/connections%2Ev1/memory%2Elan1.json')).toBe(true);
    expect(has(root, 'state.kv/oauth%2Ev1/clients/abc.json')).toBe(true);
    expect(has(root, 'profiles/personal/state.kv/cursors%2Ev1/memory%2Elan1.json')).toBe(true);
  });
});

describe('the ids it rewrites on the way', () => {
  test('a derived id becomes an allocated one, in the rows and in the grants', async () => {
    const root = await workspace({ personal: ['gmail.ada_lovelace', 'memory.main'] });

    await migrateToContract4(root);

    const rows = parse(await read(root, 'connections.yaml'))['connections'] as {
      id: string;
      provider: string;
    }[];
    // `con` for the account, `lan` for the built-in — the prefix is the one
    // thing an opaque id says, and it says whether a vendor is behind the row.
    expect(rows.find((row) => row.provider === 'gmail')?.id).toBe('con1');
    expect(rows.find((row) => row.provider === 'memory')?.id).toBe('lan1');

    const grants = parse(await read(root, 'profiles/personal/profile.yaml'))['grants'] as {
      connection: string;
    }[];
    expect(grants.map((grant) => grant.connection).sort()).toEqual(['gmail.con1', 'memory.lan1']);
  });

  test('a connection record is renamed in its key and in its body', async () => {
    // `ConnectionRepository.list` reads `provider` and `id` out of the record,
    // not out of the key it was stored under — so bytes copied verbatim would
    // sit at the new key still calling themselves the old name, and the next
    // reconcile would write a second record beside them.
    const root = await workspace(
      { personal: ['memory.main'] },
      {
        'data/state.kv/connections%2Ev1/memory%2Emain.json':
          '{"provider":"memory","id":"main","status":"active"}',
      },
    );

    await migrateToContract4(root);

    const record = JSON.parse(await read(root, 'state.kv/connections%2Ev1/memory%2Elan1.json')) as {
      provider: string;
      id: string;
      status: string;
    };
    expect(record).toEqual({ provider: 'memory', id: 'lan1', status: 'active' });
  });

  test('an id that is already allocated is left exactly alone', async () => {
    // This is not a renumbering. Running it twice must not walk `con1` to
    // `con2`, and an operator who wrote `con4` by hand keeps it.
    const root = await workspace({ personal: ['gmail.con4', 'memory.lan1'] });

    await migrateToContract4(root);

    const rows = parse(await read(root, 'connections.yaml'))['connections'] as { id: string }[];
    expect(rows.map((row) => row.id).sort()).toEqual(['con4', 'lan1']);
  });

  test('an id from before this scheme keeps working until it is migrated', async () => {
    // `main` is a legal id — opaque means opaque — so the numbering skips it
    // rather than colliding with it.
    const root = await workspace({ personal: ['gmail.main', 'gmail.con2'] });

    await migrateToContract4(root);

    const rows = parse(await read(root, 'connections.yaml'))['connections'] as { id: string }[];
    expect(rows.map((row) => row.id).sort()).toEqual(['con2', 'con3']);
  });
});

describe('what it stamps, and when', () => {
  test('the declaration moves into the directory it names, and is stamped last', async () => {
    const root = await workspace({ personal: ['memory.main'] });

    await migrateToContract4(root);

    const config = parse(await read(root, 'profiles/personal/profile.yaml')) as {
      contract: number;
      grants: unknown[];
    };
    expect(config.contract).toBe(SUPPORTED_CONTRACT);
    // Nothing about the file's *shape* changes — only where it lives.
    expect(config.grants).toHaveLength(1);
    expect(has(root, 'profiles/personal.yaml')).toBe(false);
  });

  test('the registry is renamed, and the old name goes', async () => {
    const root = await workspace({ personal: ['memory.main'] });

    await migrateToContract4(root);

    expect(parse(await read(root, 'workspaces.yaml'))['workspaces']).toBeDefined();
    expect(has(root, 'lanes-link.yaml')).toBe(false);
  });

  test('apply: false reports and writes nothing', async () => {
    const root = await workspace(
      { personal: ['memory.main'] },
      { 'data/memory/main/a-note.md': 'a note' },
    );

    const migration = await migrateToContract4(root, { apply: false });

    expect(migration.alreadyCurrent).toBe(false);
    expect(migration.changes.length).toBeGreaterThan(0);
    expect(has(root, 'data/memory/main/a-note.md')).toBe(true);
    expect(has(root, 'profiles/personal/profile.yaml')).toBe(false);
    expect(has(root, 'lanes-link.yaml')).toBe(true);
  });

  test('a second run finds nothing to do', async () => {
    const root = await workspace(
      { personal: ['memory.main'] },
      { 'data/memory/main/a-note.md': 'a note' },
    );

    await migrateToContract4(root);
    expect(await needsContract4(root)).toBe(false);

    const again = await migrateToContract4(root);
    expect(again.alreadyCurrent).toBe(true);
    expect(await read(root, 'profiles/personal/memory/lan1/a-note.md')).toBe('a note');
  });

  test('an interruption between the bytes and the stamp is finished by a rerun', async () => {
    // The stamp is the record that this finished, not a step among steps.
    // Contract 3 shipped with it written first, which left profiles claiming
    // the new contract with every byte at the old path — and a rerun that read
    // the stamp and found nothing to do.
    const root = await workspace(
      { personal: ['memory.main'] },
      { 'data/memory/main/a-note.md': 'a note' },
    );

    // The state a crash leaves: bytes moved, declaration moved, stamp not
    // written. `needsContract4` reads the stamp, so it must still say yes.
    await mkdir(join(root, 'profiles', 'personal'), { recursive: true });
    await writeFile(
      join(root, 'profiles', 'personal', 'profile.yaml'),
      PROFILE('personal', ['memory.main']),
    );
    await rm(join(root, 'profiles', 'personal.yaml'));

    expect(await needsContract4(root)).toBe(true);

    await migrateToContract4(root);
    expect(await needsContract4(root)).toBe(false);
    expect(await read(root, 'profiles/personal/memory/lan1/a-note.md')).toBe('a note');
  });
});
