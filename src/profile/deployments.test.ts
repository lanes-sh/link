import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDeployment, readDeployments, recordDeployment } from './deployments.ts';

/**
 * The index that survives a profile being rewritten.
 *
 * Everything here is about one property: that losing `targets.cloud` from a
 * profile does not lose the deployment. The tests are written against that
 * failure rather than against the API.
 */

const roots: string[] = [];

async function workspace(contents = 'contract: 1\n'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-idx-'));
  roots.push(root);
  await writeFile(join(root, 'lanes-link.yaml'), contents);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('recording where a deployment lives', () => {
  test('a workspace with no deployments reports none, rather than failing', async () => {
    expect(await readDeployments(await workspace())).toEqual([]);
    expect(await findDeployment(await workspace(), 'cloud')).toBeUndefined();
  });

  test('a recorded deployment is found again by target', async () => {
    const root = await workspace();
    await recordDeployment(root, { target: 'cloud', workspace: 'gs://your-bucket' });

    expect(await findDeployment(root, 'cloud')).toMatchObject({
      target: 'cloud',
      workspace: 'gs://your-bucket',
    });
  });

  test('and is still found after the profile that declared it is gone', async () => {
    // The whole point. No profile is consulted here, which is what makes the
    // record survive one being rewritten.
    const root = await workspace();
    await recordDeployment(root, {
      target: 'cloud',
      workspace: 'gs://your-bucket',
      primary: 'personal',
    });

    expect(await findDeployment(root, 'cloud')).toMatchObject({
      workspace: 'gs://your-bucket',
      primary: 'personal',
    });
  });

  test('redeploying the same target replaces its entry, and does not append', async () => {
    // A second entry would be a history, and a history is a thing to read wrong.
    const root = await workspace();
    await recordDeployment(root, { target: 'cloud', workspace: 'gs://first-bucket' });
    await recordDeployment(root, { target: 'cloud', workspace: 'gs://second-bucket' });

    const records = await readDeployments(root);
    expect(records).toHaveLength(1);
    expect(records[0]!.workspace).toBe('gs://second-bucket');
  });

  test('a field the caller did not supply is carried forward', async () => {
    // A redeploy that does not ask who the primary is must not silently unset it.
    const root = await workspace();
    await recordDeployment(root, {
      target: 'cloud',
      workspace: 'gs://your-bucket',
      primary: 'personal',
    });
    await recordDeployment(root, { target: 'cloud', workspace: 'gs://your-bucket' });

    expect((await findDeployment(root, 'cloud'))?.primary).toBe('personal');
  });

  test('two targets are two records', async () => {
    const root = await workspace();
    await recordDeployment(root, { target: 'cloud', workspace: 'gs://one-bucket' });
    await recordDeployment(root, { target: 'staging', workspace: 'gs://two-bucket' });

    expect((await readDeployments(root)).map((entry) => entry.target)).toEqual([
      'cloud',
      'staging',
    ]);
  });

  test('the operator’s comments survive being indexed', async () => {
    const root = await workspace('# why this workspace exists\ncontract: 1\n');
    await recordDeployment(root, { target: 'cloud', workspace: 'gs://your-bucket' });

    expect(await readFile(join(root, 'lanes-link.yaml'), 'utf8')).toContain(
      '# why this workspace exists',
    );
  });

  test('an unparseable workspace file is not a reason to fail a recovery', async () => {
    // The caller has other ways to find a target; this is only the cheapest.
    const root = await workspace('contract: 1\n  : not yaml : [\n');
    expect(await readDeployments(root)).toEqual([]);
  });
});
