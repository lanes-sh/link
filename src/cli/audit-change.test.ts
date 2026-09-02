import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceYaml } from '#profile/testing.ts';
import { openAudit } from '#deployments/target.ts';
import { openTarget, loadProfileConfig, type Config } from '#profile';
import { openSecrets, openStorage } from '#deployments/target.ts';
import { PROVIDERS } from '#providers/index.ts';
import { CONFIG_CAPABILITIES, CONFIG_PROVIDER, recordConfigChange } from './audit-change.ts';
import { createProfile } from './commands/profile.ts';

/**
 * Config changes reach the same log as the calls they permit.
 *
 * The test that matters is the round trip, not the call: a config event is
 * useless if `tail` cannot read it back, and the two sit either side of a chain
 * encoder that has never had to carry a row with no connection on it.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<{ root: string; config: Config }> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-audit-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));

  const created = await createProfile('personal', { targets: ['local'], nonInteractive: true });
  void created;
  const { config } = await loadProfileConfig(root, 'personal');
  return { root, config };
}

async function tail(root: string, config: Config) {
  const resolved = await openTarget(root, 'local');
  const input = { declared: resolved.declared, config, root: resolved.workspaceRoot, target: 'local' };
  return openAudit(await openStorage(input, await openSecrets(input))).tail({ limit: 50 });
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('recordConfigChange', () => {
  test('a change is readable back through the same tail that reads tool calls', async () => {
    const { root, config } = await workspace();

    await recordConfigChange(config, root, 'local', {
      capability: 'config.member.add',
      scope: 'personal',
      arguments: { subject: 'lanes:someone', role: 'member' },
    });

    const events = await tail(root, config);
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.capability).toBe('config.member.add');
    expect(event.provider).toBe(CONFIG_PROVIDER);
    expect(event.profile).toBe('personal');
    expect(event.arguments).toEqual({ subject: 'lanes:someone', role: 'member' });
    // Recorded after the fact, so there is no denial to express and none to read
    // as one — a config row that said "denied" would describe nothing.
    expect(event.authorization).toBe('allowed');
    expect(event.status).toBe('ok');
  });

  test('a workspace-scoped change carries the connection it was about', async () => {
    const { root, config } = await workspace();

    await recordConfigChange(config, root, 'local', {
      capability: 'config.connection.create',
      scope: 'local',
      connection: 'gmail.work',
      arguments: { account: 'someone@example.com' },
    });

    const [event] = await tail(root, config);
    expect(event?.connection).toBe('gmail.work');
    expect(event?.profile).toBe('local');
  });

  test('several changes chain, and verify', async () => {
    const { root, config } = await workspace();

    for (const capability of ['config.profile.add', 'config.policy.allow'] as const) {
      await recordConfigChange(config, root, 'local', { capability, scope: 'personal' });
    }

    const resolved = await openTarget(root, 'local');
    const input = { declared: resolved.declared, config, root: resolved.workspaceRoot, target: 'local' };
    const store = openAudit(await openStorage(input, await openSecrets(input)));

    expect((await store.tail({ limit: 50 })).map((event) => event.capability)).toEqual(
      expect.arrayContaining(['config.profile.add', 'config.policy.allow']),
    );

    // Each call is its own run, which is what the chain is per (`audit/chain.ts`)
    // — so two of them must still verify rather than read as a broken sequence.
    const verified = await store.verify();
    expect(verified.ok).toBe(true);
    expect(verified.breaks).toEqual([]);
  });

  test('a log that cannot be written does not fail the command', async () => {
    const { config } = await workspace();
    const notes: string[] = [];

    // A workspace that is not in the registry: `openTarget` throws, which is
    // the shape of every real failure here — an unreachable bucket, a missing
    // credential. The change is already on disk by now, so this must warn.
    await recordConfigChange(config, '/nonexistent', 'nowhere', {
      capability: 'config.member.add',
      scope: 'personal',
    }, (note) => notes.push(note));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('not recorded');
  });
});

describe('the config pseudo-provider', () => {
  test('no provider may claim it', () => {
    // The whole value of a `config` row is that it cannot be confused with a
    // provider's. A manifest with this id would make the two indistinguishable
    // in the log, so the reservation is a test rather than a comment.
    const ids = PROVIDERS.map((entry) => ('manifest' in entry ? entry.manifest.id : entry.id));
    expect(ids).not.toContain(CONFIG_PROVIDER);
  });

  test('every capability is namespaced under it', () => {
    for (const capability of CONFIG_CAPABILITIES) {
      expect(capability.startsWith(`${CONFIG_PROVIDER}.`)).toBe(true);
    }
  });
});
