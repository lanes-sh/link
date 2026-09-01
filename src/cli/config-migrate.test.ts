import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIONS_FILE, parseConfig, readConnections, type Config } from '#profile';
import type { SecretStore } from '#secrets';
import { doctor } from './commands/operate.ts';
import { createProfile } from './commands/profile.ts';
import { ConfigDocument } from './config-edit.ts';
import { migrateRenamedProviders, pendingRenames, shapeOf } from './config-migrate.ts';
import { openSecretStoreFor } from './runtime.ts';

/**
 * Undoing a provider rename on a profile that will not load because of one.
 *
 * The property that matters most is the one that is easiest to lose: **nothing
 * is guessed**. A `tasks` row labelled anything but `Tasks` is ambiguous between
 * a pre-rename Google Tasks connection and a hand-edited built-in one, and the
 * two fixes are opposite — so the stored credential decides, because only the
 * OAuth connection has ever had one. Take the evidence away and the repair must
 * report rather than pick, which is what most of this file is about.
 *
 * The second property is that a repair which cannot be finished is not started:
 * the credential is copied before the config is saved, and the old reference
 * removed only after `save` has validated what landed.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

/** The pre-rename row, exactly as a profile written before ADR-051 holds it. */
const GOOGLE_TASKS = '  - { id: personal, provider: tasks, account: personal }';

/**
 * A workspace whose profile still names the old id.
 *
 * Built by rewriting the template's built-in row rather than by appending, so
 * the file holds one `tasks` row and one `tasks.*` rule — the shape a real
 * pre-0.5.0 profile has, where the built-in did not exist yet to be declared.
 */
async function brokenWorkspace(options: { keepBuiltIn?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-migrate-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await createProfile('personal', { targets: ['local'] });

  // The row is the workspace's now, and the grant that names it is the
  // profile's (ADR-057) — so a pre-rename workspace is broken in two files.
  const connectionsPath = join(root, CONNECTIONS_FILE);
  const held = await Bun.file(connectionsPath).text();
  const builtIn = '  - { id: main, provider: tasks, account: Tasks }';

  await Bun.write(
    connectionsPath,
    held.replace(builtIn, options.keepBuiltIn === true ? `${builtIn}\n${GOOGLE_TASKS}` : GOOGLE_TASKS),
  );

  const path = join(root, 'profiles', 'personal.yaml');
  const text = await Bun.file(path).text();
  const grant = '  - { connection: tasks.main, allow: [tasks.*], deny: [] }';

  await Bun.write(
    path,
    text.replace(
      grant,
      options.keepBuiltIn === true
        ? `${grant}\n  - { connection: tasks.personal, allow: [tasks.*], deny: [] }`
        : '  - { connection: tasks.personal, allow: [tasks.*], deny: [] }',
    ),
  );

  return root;
}

async function open(root: string): Promise<{
  document: ConfigDocument;
  profiles: ConfigDocument[];
  credentials: SecretStore;
}> {
  const document = await ConfigDocument.openKey(root, CONNECTIONS_FILE);
  const profiles = [await ConfigDocument.open(root, 'personal')];
  return {
    document,
    profiles,
    credentials: await openSecretStoreFor(shapeOf(profiles[0]!), root, 'local'),
  };
}

async function onDisk(root: string): Promise<Config> {
  return parseConfig(await Bun.file(join(root, 'profiles', 'personal.yaml')).text()).config;
}

/** What the workspace holds. */
async function held(root: string): Promise<string[]> {
  return (await readConnections(root)).connections.map((one) => `${one.provider}.${one.id}`);
}

/** What the profile grants, which is the other half of a rename. */
function keys(config: Config): string[] {
  return config.grants.map((grant) => grant.connection);
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('a profile still naming a renamed provider', () => {
  test('is refused when the workspace is read, which is the state this repairs', async () => {
    // The refusal moved with the row it inspects. Its evidence is the account —
    // "is this really Google Tasks?" — and an account lives in connections.yaml
    // now (ADR-057), so the profile loader has nothing to judge it by.
    const root = await brokenWorkspace();
    await expect(readConnections(root)).rejects.toThrow(/set account to Tasks/);
  });

  test('is found in raw YAML, which is all there is to read', async () => {
    const root = await brokenWorkspace();
    const { document } = await open(root);

    expect(pendingRenames(document)).toEqual([
      expect.objectContaining({ from: 'tasks', to: 'google_tasks', id: 'personal' }),
    ]);
  });
});

describe('with a stored credential to prove what the row was', () => {
  async function ready(options: { keepBuiltIn?: boolean } = {}) {
    const root = await brokenWorkspace(options);
    const { document, profiles, credentials } = await open(root);
    await credentials.set('tasks/personal', '{"refresh_token":"not-a-real-token"}');
    return { root, document, profiles, credentials };
  }

  test('reports what it would do, and writes nothing', async () => {
    const { root, document, profiles, credentials } = await ready();

    const migration = await migrateRenamedProviders(document, profiles, credentials, { apply: false });

    expect(migration.changes).toContain('credential: tasks/personal → google_tasks/personal');
    expect(migration.blocked).toEqual([]);
    // The profile itself loads: its grant names `tasks.personal`, and whether
    // that is Google's or the built-in is a question only the account answers.
    await expect(readConnections(root)).rejects.toThrow(/set provider to google_tasks/);
    expect(await credentials.has('tasks/personal')).toBe(true);
    expect(await credentials.has('google_tasks/personal')).toBe(false);
  });

  test('moves the row, the rule and the credential together', async () => {
    const { root, document, profiles, credentials } = await ready();

    const migration = await migrateRenamedProviders(document, profiles, credentials, { apply: true });
    expect(migration.blocked).toEqual([]);

    const config = await onDisk(root);
    expect(await held(root)).toContain('google_tasks.personal');
    expect(keys(config)).toContain('google_tasks.personal');
    expect(await held(root)).not.toContain('tasks.personal');
    expect(keys(config)).not.toContain('tasks.personal');
    expect(config.grants.flatMap((grant) => grant.allow.map((rule) => rule.capability))).toContain(
      'google_tasks.*',
    );
    expect(config.grants.flatMap((grant) => grant.allow.map((rule) => rule.capability))).not.toContain(
      'tasks.*',
    );

    // All three, because any one alone is inert: the row without the rule is
    // granted nothing, and either without the credential is unauthorized.
    expect(await credentials.has('google_tasks/personal')).toBe(true);
    expect(await credentials.has('tasks/personal')).toBe(false);
    expect(await credentials.get('google_tasks/personal')).toBe('{"refresh_token":"not-a-real-token"}');
  });

  test('leaves the comments an operator reads the file for', async () => {
    const { root, document, profiles, credentials } = await ready();
    await migrateRenamedProviders(document, profiles, credentials, { apply: true });

    const text = await Bun.file(join(root, 'profiles', 'personal.yaml')).text();
    expect(text).toContain('# Lanes Link profile: personal');
    expect(text).toContain('# One row per connection this profile may reach');
  });

  test('is a no-op the second time, because there is nothing left to move', async () => {
    const { root, credentials } = await ready();
    const reopen = async () => ({
      connections: await ConfigDocument.openKey(root, CONNECTIONS_FILE),
      profiles: [await ConfigDocument.open(root, 'personal')],
    });

    const first = await reopen();
    await migrateRenamedProviders(first.connections, first.profiles, credentials, { apply: true });

    const second = await reopen();
    const again = await migrateRenamedProviders(
      second.connections,
      second.profiles,
      credentials,
      { apply: true },
    );
    expect(again.rows).toEqual([]);
    expect(again.changes).toEqual([]);
  });

  test('a workspace holding both rows migrates one and leaves the other', async () => {
    // This used to be the hard case, and ADR-058 dissolved it. A rule lived in
    // one flat block and named a provider, so a profile holding the built-in
    // *and* a pre-rename row had one `tasks.*` serving both — moving it would
    // silently revoke whichever kept its name, so the migration reported rather
    // than guessed. A rule lives inside the row that names one connection now,
    // so each of the two grants carries its own and neither can speak for the
    // other. There is nothing left to decide, and nothing to block.
    const { root, document, profiles, credentials } = await ready({ keepBuiltIn: true });

    const migration = await migrateRenamedProviders(document, profiles, credentials, { apply: true });

    expect(migration.blocked).toEqual([]);

    expect(await held(root)).toContain('google_tasks.personal');
    expect(await held(root)).toContain('tasks.main');

    const config = await onDisk(root);
    const google = config.grants.find((grant) => grant.connection === 'google_tasks.personal');
    const builtIn = config.grants.find((grant) => grant.connection === 'tasks.main');

    expect(google?.allow.map((rule) => rule.capability)).toEqual(['google_tasks.*']);
    // Untouched, and still valid: its rule names its own provider.
    expect(builtIn?.allow.map((rule) => rule.capability)).toEqual(['tasks.*']);
  });
});

describe('a deny rule follows the rename too', () => {
  test('because leaving it behind re-enables what was switched off', async () => {
    const root = await brokenWorkspace();
    const path = join(root, 'profiles', 'personal.yaml');
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace(
        '  - { connection: tasks.personal, allow: [tasks.*], deny: [] }',
        '  - { connection: tasks.personal, allow: [tasks.*], deny: [tasks.tasks.tasks.delete] }',
      ),
    );

    const { document, profiles, credentials } = await open(root);
    await credentials.set('tasks/personal', 'token');
    await migrateRenamedProviders(document, profiles, credentials, { apply: true });

    const grant = (await onDisk(root)).grants.find(
      (row) => row.connection === 'google_tasks.personal',
    );
    expect(grant?.deny.map((rule) => rule.capability)).toEqual(['google_tasks.tasks.tasks.delete']);
  });
});

describe('through doctor, which is the command an operator reaches for', () => {
  test('--fix closes the loop the refusal opens', async () => {
    // The end-to-end property: the load refusal names `doctor --fix`, and
    // running it makes the profile load. Everything else here tests a half of
    // that; this is the half nobody can verify by reading.
    const root = await brokenWorkspace();
    const { credentials } = await open(root);
    await credentials.set('tasks/personal', 'token');

    // Restored, because `doctor` reports a repair by exit code and a test runner
    // reads the same one.
    const previous = process.exitCode;
    try {
      await doctor({ profile: 'personal', target: 'local', fix: true, quiet: true });
    } finally {
      process.exitCode = previous;
    }

    expect(keys(await onDisk(root))).toContain('google_tasks.personal');
  });
});

describe('with nothing to prove what the row was', () => {
  test('reports both readings and changes nothing', async () => {
    // The hand-edited built-in is a real profile too, and its fix is the
    // opposite one. Picking here would be the silent rebind the refusal exists
    // to prevent, arrived at from the other direction.
    const root = await brokenWorkspace();
    const { document, profiles, credentials } = await open(root);

    const migration = await migrateRenamedProviders(document, profiles, credentials, { apply: true });

    expect(migration.changes).toEqual([]);
    expect(migration.blocked.join('\n')).toMatch(/no stored credential/);
    // The profile itself loads: its grant names `tasks.personal`, and whether
    // that is Google's or the built-in is a question only the account answers.
    await expect(readConnections(root)).rejects.toThrow(/set provider to google_tasks/);
  });
});
