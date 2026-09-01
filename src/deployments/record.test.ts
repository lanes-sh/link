import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, type TargetConfig } from '#profile';
import { recordDeployment } from './record.ts';

/**
 * What a deploy writes down about itself, on both ends.
 *
 * The declaration goes into the target's own workspace and a pointer stays on
 * the machine that ran it (ADR-052). The deploy record — who opens the endpoint,
 * when it was last rolled, and by which release — goes on both, so a second
 * machine reading the registry learns it and so this one can answer "what is
 * running up there" without waking the endpoint.
 *
 * The version is written by a *second* call, after the rollout. A build that
 * fails must not leave a version recorded that never served a request.
 */

const roots: string[] = [];
const HOME = process.env['LANES_LINK_HOME'];

afterEach(() => {
  if (HOME === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = HOME;
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-record-'));
  roots.push(root);
  await writeFile(join(root, 'lanes-link.yaml'), 'contract: 3\n');
  return root;
}

const declared = {
  credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
  storage: { adapter: 'gcs', bucket: 'lanes-link-demo-data' },
} as TargetConfig;

/** Both ends, as `deploy` has them: a local machine and the target's workspace. */
async function ends() {
  const machine = await workspace();
  const target = await workspace();
  process.env['LANES_LINK_HOME'] = machine;
  return { machine, target };
}

const record = (target: string) => ({
  workspace: target,
  target: 'cloud',
  declared,
  primary: 'personal',
  at: '2026-08-28T09:00:00.000Z',
});

describe('recording a deployment', () => {
  test('the target declares itself, and the machine keeps a pointer', async () => {
    const { machine, target } = await ends();
    await recordDeployment(record(target));

    const there = (await readRegistry(target))['cloud']!;
    const here = (await readRegistry(machine))['cloud']!;

    expect(there.storage?.bucket).toBe('lanes-link-demo-data');
    expect(there.at).toBeUndefined();
    expect(here.at).toBe(target);
    expect(here.storage).toBeUndefined();
  });

  test('the deploy record lands on both ends', async () => {
    const { machine, target } = await ends();
    await recordDeployment({ ...record(target), version: '0.6.6' });

    for (const root of [machine, target]) {
      expect(await readRegistry(root)).toMatchObject({
        cloud: {
          primary: 'personal',
          last_deploy: '2026-08-28T09:00:00.000Z',
          last_deploy_version: '0.6.6',
        },
      });
    }
  });

  test('no version until there is one, so a failed build records nothing about it', async () => {
    // The declaration has to land before the revision boots; the version can
    // only be true after the rollout. That asymmetry is the whole reason `deploy`
    // calls this twice.
    const { machine, target } = await ends();
    await recordDeployment(record(target));

    for (const root of [machine, target]) {
      expect((await readRegistry(root))['cloud']?.last_deploy_version).toBeUndefined();
    }
  });

  test('the second call adds the version without disturbing the shape of either entry', async () => {
    const { machine, target } = await ends();
    const first = record(target);
    await recordDeployment(first);
    await recordDeployment({ ...first, version: '0.6.6' });

    const there = (await readRegistry(target))['cloud']!;
    const here = (await readRegistry(machine))['cloud']!;

    // A pointer beside adapters is what the schema refuses, and this is the one
    // write that touches both entries twice.
    expect(there.storage?.bucket).toBe('lanes-link-demo-data');
    expect(there.at).toBeUndefined();
    expect(here.at).toBe(target);
    expect(here.last_deploy_version).toBe('0.6.6');
  });
});
