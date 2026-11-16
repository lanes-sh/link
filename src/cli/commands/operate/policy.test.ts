import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceYaml } from '#profile/testing.ts';
import { loadProfileConfig } from '#profile';
import { createProfile } from '../profile.ts';
import { policyRemove, policyRule } from './policy.ts';

/**
 * A deny can be withdrawn, and the family that writes rules can take them away.
 *
 * `SUBCOMMANDS.policy` was `['list', 'allow', 'deny']`: the policy family could
 * add a rule in both directions and remove neither. `allow` is not the inverse
 * of `deny` and cannot be — a deny beats an allow on the same connection
 * whatever the order in the file, which `policy list` prints as its own closing
 * line and which `config-repair.ts` depends on. So the only ways back were
 * editing `profile.yaml` behind the tool, or `revoke` then `grant`, which
 * resets every other rule on the connection on the way past.
 *
 * Nothing tested this family at all before this file: `operate.test.ts` covers
 * the Markdown cell escaping and no test reached `policyRule`.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  try {
    (process.stdout as unknown as { write: () => boolean }).write = (): boolean => true;
    return await body();
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

/** A fresh profile, and the owner-layer connection its grants already carry. */
async function workspace(): Promise<{ root: string; connection: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-policy-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));

  await quietly(() => createProfile('personal', { targets: ['local'], nonInteractive: true }));

  const { config } = await loadProfileConfig(root, 'personal');
  const row = config.grants.find((grant) => grant.connection.startsWith('lanes_memory.'));
  if (!row) throw new Error('a fresh profile should grant the owner layer');
  return { root, connection: row.connection };
}

async function rules(root: string, connection: string) {
  const { config } = await loadProfileConfig(root, 'personal');
  const grant = config.grants.find((one) => one.connection === connection)!;
  return {
    allow: grant.allow.map((rule) => rule.capability),
    deny: grant.deny.map((rule) => rule.capability),
  };
}

const FLAGS = (connection: string) => ({
  profile: 'personal',
  target: 'local',
  workspace: 'local',
  connection,
});

describe('policy remove', () => {
  test('withdraws a deny, which allow could not do', async () => {
    const { root, connection } = await workspace();
    const flags = FLAGS(connection);

    await quietly(() => policyRule('deny', 'lanes_memory.write', flags));
    expect((await rules(root, connection)).deny).toContain('lanes_memory.write');

    await quietly(() => policyRemove('lanes_memory.write', flags));
    expect((await rules(root, connection)).deny).not.toContain('lanes_memory.write');
  });

  test('takes both signs, because "stop having an opinion" is what one means', async () => {
    const { root, connection } = await workspace();
    const flags = FLAGS(connection);

    await quietly(() => policyRule('allow', 'lanes_memory.write', flags));
    await quietly(() => policyRule('deny', 'lanes_memory.write', flags));

    const before = await rules(root, connection);
    expect(before.allow).toContain('lanes_memory.write');
    expect(before.deny).toContain('lanes_memory.write');

    await quietly(() => policyRemove('lanes_memory.write', flags));

    const after = await rules(root, connection);
    expect(after.allow).not.toContain('lanes_memory.write');
    expect(after.deny).not.toContain('lanes_memory.write');
  });

  test('leaves every other rule on the connection alone', async () => {
    // The property `revoke` + `grant` could not offer, which is what made that
    // workaround cost more than the rule being withdrawn.
    const { root, connection } = await workspace();
    const flags = FLAGS(connection);

    await quietly(() => policyRule('deny', 'lanes_memory.write', flags));
    await quietly(() => policyRule('deny', 'lanes_memory.forget', flags));
    await quietly(() => policyRemove('lanes_memory.write', flags));

    const after = await rules(root, connection);
    expect(after.deny).toEqual(['lanes_memory.forget']);
    expect(after.allow).toContain('lanes_memory.*');
  });

  test('a literal match, so a pattern removes only the rule spelled that way', async () => {
    const { root, connection } = await workspace();
    const flags = FLAGS(connection);

    await quietly(() => policyRule('deny', 'lanes_memory.write', flags));
    await quietly(() => policyRemove('lanes_memory.*', flags));

    const after = await rules(root, connection);
    expect(after.allow).not.toContain('lanes_memory.*');
    // Removing by pattern would have taken this with it, which is one command
    // deleting a rule it never named.
    expect(after.deny).toContain('lanes_memory.write');
  });

  test('refuses with the connection’s rules when the capability matches none', async () => {
    const { connection } = await workspace();

    const refused = policyRemove('lanes_memory.nonesuch', FLAGS(connection));

    await expect(refused).rejects.toThrow(/No rule for "lanes_memory.nonesuch"/);
    await expect(refused).rejects.toThrow(/lanes_memory\.\*/);
  });

  test('says an owner-layer allow will be granted again, and how to keep it off', async () => {
    // Removing an allow does not keep an owner surface off: the next start,
    // connect or deploy repairs it (ADR-050). The repair stands down for a
    // deny, so the two are not interchangeable and the command says which.
    const { connection } = await workspace();
    const flags = FLAGS(connection);

    const write = process.stdout.write.bind(process.stdout);
    let out = '';
    try {
      (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
        out += chunk;
        return true;
      };
      await policyRemove('lanes_memory.*', flags);
    } finally {
      (process.stdout as unknown as { write: typeof write }).write = write;
    }

    expect(out).toContain('owner surface');
    expect(out).toContain('policy deny lanes_memory.*');
  });

  test('refuses without --connection, rather than guessing which row', async () => {
    await workspace();

    const refused = policyRemove('lanes_memory.write', { profile: 'personal', target: 'local' });

    await expect(refused).rejects.toThrow(/--connection is required/);
  });
});
