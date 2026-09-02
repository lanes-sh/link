import { workspaceYaml } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTarget, removeTarget } from './deployments.ts';
import { readRegistry } from './registry.ts';

/**
 * Writing the target registry.
 *
 * This used to be an *index* beside the profile's own `workspaces:` block, and
 * every test here was about one property: that losing `targets.cloud` from a
 * profile did not lose the deployment. ADR-052 removed the block, so the
 * property is no longer something to preserve — it is the only shape there is.
 *
 * What the tests are about now is the shape of an entry: a declaration or a
 * pointer, never both, and a write that carries forward what the caller did not
 * mention.
 */

const roots: string[] = [];

async function workspace(contents = workspaceYaml(['local', 'cloud', 'staging'])): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-idx-'));
  roots.push(root);
  await writeFile(join(root, 'workspaces.yaml'), contents);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('recording where a target lives', () => {
  test('a workspace with no registry reports none, rather than failing', async () => {
    const root = await workspace('contract: 4\n');
    expect(await readRegistry(root)).toEqual({});
  });

  test('a recorded pointer is found again by target', async () => {
    const root = await workspace();
    await recordTarget(root, 'cloud', { at: 'gs://your-bucket' });

    expect((await readRegistry(root))['cloud']).toMatchObject({ at: 'gs://your-bucket' });
  });

  test('a pointer replaces a declaration rather than merging with it', async () => {
    // This is `deploy` handing the target over to the workspace it just wrote.
    // An entry carrying both a `workspace:` and adapters is what the schema
    // refuses, so merging here would write a file that cannot be read back.
    const root = await workspace();
    await recordTarget(root, 'cloud', { at: 'gs://your-bucket' });

    const entry = (await readRegistry(root))['cloud']!;
    expect(entry.at).toBe('gs://your-bucket');
    expect(entry.credentials).toBeUndefined();
    expect(entry.storage).toBeUndefined();
  });

  test('redeploying the same target replaces its entry, and does not append', async () => {
    // A second entry would be a history, and a history is a thing to read wrong.
    const root = await workspace();
    await recordTarget(root, 'cloud', { at: 'gs://first-bucket' });
    await recordTarget(root, 'cloud', { at: 'gs://second-bucket' });

    const registry = await readRegistry(root);
    expect(Object.keys(registry).filter((name) => name === 'cloud')).toHaveLength(1);
    expect(registry['cloud']?.at).toBe('gs://second-bucket');
  });

  test('a declaration replaces a pointer, so a bucket never points at itself', async () => {
    // `deploy` writes the bucket's own registry after the upload. Merging there
    // left this machine's `at:` on the entry — and a bucket pointing at
    // itself is a loop `openTarget` refuses, on the target just deployed.
    const root = await workspace('contract: 4\n');
    await recordTarget(root, 'cloud', { at: 'gs://your-bucket', primary: 'personal' });
    await recordTarget(root, 'cloud', {
      credentials: { adapter: 'gcp-secret-manager', project: 'p' },
      storage: { adapter: 'gcs', bucket: 'your-bucket' },
    });

    const entry = (await readRegistry(root))['cloud']!;
    expect(entry.at).toBeUndefined();
    expect(entry.storage?.bucket).toBe('your-bucket');
    // The deploy record is the one thing that crosses either way.
    expect(entry.primary).toBe('personal');
  });

  test('the deploy record survives a declaration becoming a pointer', async () => {
    // A redeploy that does not ask who the primary is must not silently unset
    // it — and handing the target over to its own workspace is exactly when the
    // rest of the entry is being replaced wholesale.
    const root = await workspace();
    await recordTarget(root, 'cloud', {
      at: 'gs://your-bucket',
      primary: 'personal',
      last_deploy_version: '0.6.5',
    });
    await recordTarget(root, 'cloud', { at: 'gs://your-bucket' });

    const entry = (await readRegistry(root))['cloud']!;
    expect(entry.primary).toBe('personal');
    // The version travels with the rest of the record. `deploy` writes the
    // declaration before the rollout and the version after it, so the second
    // write is a partial one — and losing what the first said would leave the
    // registry claiming a target nobody has ever deployed.
    expect(entry.last_deploy_version).toBe('0.6.5');
  });

  test('two targets are two entries', async () => {
    const root = await workspace('contract: 4\n');
    await recordTarget(root, 'cloud', { at: 'gs://one-bucket' });
    await recordTarget(root, 'staging', { at: 'gs://two-bucket' });

    expect(Object.keys(await readRegistry(root))).toEqual(['cloud', 'staging']);
  });

  test('removing a target leaves the others', async () => {
    const root = await workspace();
    await removeTarget(root, 'staging');

    expect(Object.keys(await readRegistry(root))).toEqual(['cloud', 'local']);
  });

  test('the operator’s comments survive being written to', async () => {
    const root = await workspace('# why this workspace exists\ncontract: 4\n');
    await recordTarget(root, 'cloud', { at: 'gs://your-bucket' });

    expect(await readFile(join(root, 'workspaces.yaml'), 'utf8')).toContain(
      '# why this workspace exists',
    );
  });

  test('a new entry that is neither a pointer nor a declaration is refused', async () => {
    // Validated on the rendered tree before it lands, so what is checked is what
    // would be read back. A *partial* write to a target that already exists is
    // fine and merges — `deploy` stamping `last_deploy` is exactly that — which
    // is why this names one nothing has declared.
    const root = await workspace();

    await expect(recordTarget(root, 'brand_new', { primary: 'personal' })).rejects.toThrow();
  });
});

describe('a registry that is still at contract 2', () => {
  const contract2 = [
    'contract: 2',
    'default_profile: personal',
    'targets:',
    '  cloud:',
    '    workspace: gs://your-bucket',
    '    primary: personal',
    '    last_deploy_version: 0.7.2',
    '  local:',
    '    credentials: { adapter: file }',
    '    storage: { adapter: filesystem }',
    '',
  ].join('\n');

  test('is updated in place, rather than growing a second registry beside it', async () => {
    // `deploy` migrates the *target* workspace, never the local one — so
    // deploying to a bucket from a laptop that has not run `update` yet lands
    // here with a contract-2 file. This read and wrote `workspaces:`
    // unconditionally, found no registry under it, and wrote a second block
    // beside the first. `workspaceSchema` has no `targets` key and zod strips
    // what it does not declare, so the hybrid validated and landed.
    const root = await workspace(contract2);

    await recordTarget(root, 'cloud', {
      at: 'gs://your-bucket',
      primary: 'personal',
      last_deploy_version: '0.8.0',
    });

    const text = await readFile(join(root, 'workspaces.yaml'), 'utf8');
    expect(text).not.toContain('workspaces:');
    expect(text).toContain('last_deploy_version: 0.8.0');
    expect(text).not.toContain('0.7.2');
  });

  test('keeps the spelling its own contract uses for a pointer', async () => {
    // Contract 2 spells it `workspace:`; `at:` arrived with contract 3. Writing
    // the new spelling into the old block would leave a pointer that contract's
    // own schema does not recognise.
    const root = await workspace(contract2);

    await recordTarget(root, 'cloud', { at: 'gs://your-bucket', primary: 'personal' });

    const text = await readFile(join(root, 'workspaces.yaml'), 'utf8');
    expect(text).toContain('workspace: gs://your-bucket');
    expect(text).not.toContain('at: gs://your-bucket');
  });

  test('carries forward a field the caller did not mention', async () => {
    // The merge `recordTarget` promises, on the legacy path too.
    const root = await workspace(contract2);

    await recordTarget(root, 'cloud', { at: 'gs://your-bucket', last_deploy: 'now' });

    expect(await readFile(join(root, 'workspaces.yaml'), 'utf8')).toContain('primary: personal');
  });
});
