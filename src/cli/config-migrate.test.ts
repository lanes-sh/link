import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type Config } from '#profile';
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

  const path = join(root, 'profiles', 'personal.yaml');
  const text = await Bun.file(path).text();
  const builtIn = '  - { id: main, provider: tasks, account: Tasks }';

  await Bun.write(
    path,
    text.replace(builtIn, options.keepBuiltIn === true ? `${builtIn}\n${GOOGLE_TASKS}` : GOOGLE_TASKS),
  );

  return root;
}

async function open(root: string): Promise<{ document: ConfigDocument; credentials: SecretStore }> {
  const document = await ConfigDocument.open(root, 'personal');
  return { document, credentials: await openSecretStoreFor(shapeOf(document), root, 'local') };
}

async function onDisk(root: string): Promise<Config> {
  return parseConfig(await Bun.file(join(root, 'profiles', 'personal.yaml')).text()).config;
}

function keys(config: Config): string[] {
  return config.connections.map((one) => `${one.provider}.${one.id}`);
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('a profile still naming a renamed provider', () => {
  test('is refused by the loader, which is the state this repairs', async () => {
    const root = await brokenWorkspace();
    await expect(onDisk(root)).rejects.toThrow(/set provider to google_tasks/);
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
    const { document, credentials } = await open(root);
    await credentials.set('tasks/personal', '{"refresh_token":"not-a-real-token"}');
    return { root, document, credentials };
  }

  test('reports what it would do, and writes nothing', async () => {
    const { root, document, credentials } = await ready();

    const migration = await migrateRenamedProviders(document, credentials, { apply: false });

    expect(migration.changes).toContain('credential: tasks/personal → google_tasks/personal');
    expect(migration.blocked).toEqual([]);
    await expect(onDisk(root)).rejects.toThrow(/set provider to google_tasks/);
    expect(await credentials.has('tasks/personal')).toBe(true);
    expect(await credentials.has('google_tasks/personal')).toBe(false);
  });

  test('moves the row, the rule and the credential together', async () => {
    const { root, document, credentials } = await ready();

    const migration = await migrateRenamedProviders(document, credentials, { apply: true });
    expect(migration.blocked).toEqual([]);

    const config = await onDisk(root);
    expect(keys(config)).toContain('google_tasks.personal');
    expect(keys(config)).not.toContain('tasks.personal');
    expect(config.policy.allow.map((rule) => rule.capability)).toContain('google_tasks.*');
    expect(config.policy.allow.map((rule) => rule.capability)).not.toContain('tasks.*');

    // All three, because any one alone is inert: the row without the rule is
    // granted nothing, and either without the credential is unauthorized.
    expect(await credentials.has('google_tasks/personal')).toBe(true);
    expect(await credentials.has('tasks/personal')).toBe(false);
    expect(await credentials.get('google_tasks/personal')).toBe('{"refresh_token":"not-a-real-token"}');
  });

  test('leaves the comments an operator reads the file for', async () => {
    const { root, document, credentials } = await ready();
    await migrateRenamedProviders(document, credentials, { apply: true });

    const text = await Bun.file(join(root, 'profiles', 'personal.yaml')).text();
    expect(text).toContain('# Lanes Link profile: personal');
    expect(text).toContain('# Only what is listed here is reachable');
  });

  test('is a no-op the second time, because there is nothing left to move', async () => {
    const { root, credentials } = await ready();
    await migrateRenamedProviders(await ConfigDocument.open(root, 'personal'), credentials, {
      apply: true,
    });

    const again = await migrateRenamedProviders(
      await ConfigDocument.open(root, 'personal'),
      credentials,
      { apply: true },
    );
    expect(again.rows).toEqual([]);
    expect(again.changes).toEqual([]);
  });

  test('keeps a rule that two providers would then share', async () => {
    // A profile declaring the built-in *and* a pre-rename row has one `tasks.*`
    // serving both, so moving it would silently revoke the one that kept its
    // name. The row still moves; the rule is reported instead.
    const { root, document, credentials } = await ready({ keepBuiltIn: true });

    const migration = await migrateRenamedProviders(document, credentials, { apply: true });

    expect(migration.blocked.join('\n')).toMatch(/still declares a "tasks" connection/);

    const config = await onDisk(root);
    expect(keys(config)).toContain('google_tasks.personal');
    expect(config.policy.allow.map((rule) => rule.capability)).toContain('tasks.*');
  });
});

describe('a deny rule follows the rename too', () => {
  test('because leaving it behind re-enables what was switched off', async () => {
    const root = await brokenWorkspace();
    const path = join(root, 'profiles', 'personal.yaml');
    await Bun.write(
      path,
      (await Bun.file(path).text()).replace('deny: []', 'deny: [tasks.tasks.tasks.delete]'),
    );

    const { document, credentials } = await open(root);
    await credentials.set('tasks/personal', 'token');
    await migrateRenamedProviders(document, credentials, { apply: true });

    expect((await onDisk(root)).policy.deny.map((rule) => rule.capability)).toEqual([
      'google_tasks.tasks.tasks.delete',
    ]);
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
    const { document, credentials } = await open(root);

    const migration = await migrateRenamedProviders(document, credentials, { apply: true });

    expect(migration.changes).toEqual([]);
    expect(migration.blocked.join('\n')).toMatch(/no stored credential/);
    await expect(onDisk(root)).rejects.toThrow(/set provider to google_tasks/);
  });
});
