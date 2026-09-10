import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import { GoogleCredentialsError } from './adapters/gcp-secret-manager.ts';
import { discoverDeployments, holdsWorkspace, probeWorkspace } from './discover.ts';

/**
 * Whether a bucket holds a workspace, and — the part that was missing — whether
 * the question could be answered at all.
 *
 * The probe used to answer `false` to "is there a workspace here", "does that
 * bucket exist" and "are you logged in to Google" alike, so a laptop with no
 * credentials was told to check the bucket name.
 */

const WORKSPACE = 'workspaces.yaml';
const LEGACY = 'lanes-link.yaml';

const holding = async (...keys: string[]): Promise<BlobStore> => {
  const files = createMemoryBlobStore();
  for (const key of keys) await files.put(key, new TextEncoder().encode('contract: 5\n'));
  return files;
};

/** A store that cannot answer, the way an unauthenticated one cannot. */
const failing = (error: Error): BlobStore =>
  ({
    ...createMemoryBlobStore(),
    has: () => Promise.reject(error),
    get: () => Promise.reject(error),
  }) as BlobStore;

describe('what a bucket turns out to hold', () => {
  test('a workspace file makes it a workspace', async () => {
    expect(await probeWorkspace('gs://your-bucket', { files: await holding(WORKSPACE) })).toEqual({
      kind: 'workspace',
    });
  });

  test('an empty bucket declares no workspace', async () => {
    expect(await probeWorkspace('gs://your-bucket', { files: createMemoryBlobStore() })).toEqual({
      kind: 'absent',
    });
  });

  test('a bucket still on the old filename is a workspace that needs migrating', async () => {
    // The case this command exists for. `readWorkspace` accepts either name, so
    // reporting "no workspace" here refuses exactly the recovery it is for —
    // but calling it a workspace would be worse, since the file is keyed
    // `targets:` and would parse as declaring nothing.
    expect(await probeWorkspace('gs://your-bucket', { files: await holding(LEGACY) })).toEqual({
      kind: 'legacy',
    });
  });
});

describe('when the question cannot be answered', () => {
  test('missing credentials are reported as unreadable, not as absent', async () => {
    const error = new GoogleCredentialsError(
      'No Google credentials found. Run `gcloud auth application-default login`.',
    );

    const probe = await probeWorkspace('gs://your-bucket', { files: failing(error) });

    expect(probe.kind).toBe('unreadable');
    if (probe.kind !== 'unreadable') throw new Error('unreachable');
    expect(probe.credentials).toBe(true);
    expect(probe.reason).toContain('application-default login');
  });

  test('a permission failure is unreadable, but not a credentials problem', async () => {
    const probe = await probeWorkspace('gs://your-bucket', {
      files: failing(new Error('Cannot read your-bucket — grant roles/storage.objectAdmin.')),
    });

    expect(probe.kind).toBe('unreadable');
    if (probe.kind !== 'unreadable') throw new Error('unreachable');
    // Nothing to say about logging in, so the message must not offer it.
    expect(probe.credentials).toBe(false);
    expect(probe.reason).toContain('objectAdmin');
  });

  test('a URL naming no bucket is reported, not thrown', async () => {
    // `workspaceFiles` throws synchronously for this, which is why the store is
    // built inside the probe rather than defaulted in the signature.
    const probe = await probeWorkspace('gs://');

    expect(probe.kind).toBe('unreadable');
  });
});

describe('the boolean the bucket scan uses', () => {
  test('only a current workspace counts, so the scan is unchanged', async () => {
    expect(await holdsWorkspace('gs://x', { files: await holding(WORKSPACE) })).toBe(true);
    expect(await holdsWorkspace('gs://x', { files: await holding(LEGACY) })).toBe(false);
    expect(await holdsWorkspace('gs://x', { files: createMemoryBlobStore() })).toBe(false);
  });

  test('it still cannot tell an unreadable bucket from an empty one', async () => {
    // Deliberate: the scan sweeps every bucket in every project, and one it
    // cannot read is not a candidate. This is the assertion that says the
    // boolean was never the thing to fix — the caller that needed the
    // difference is the one that names a single bucket.
    const error = new GoogleCredentialsError('No Google credentials found.');

    expect(await holdsWorkspace('gs://x', { files: failing(error) })).toBe(false);
    expect((await probeWorkspace('gs://x', { files: failing(error) })).kind).toBe('unreadable');
  });
});

describe('searching the platform for one', () => {
  const gcloud = (result: { ok: boolean; stdout?: string; stderr?: string }) => async () => ({
    ok: result.ok,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });

  test('a gcloud that could not be asked is not reported as an empty account', async () => {
    // The same defect as the probe, one level up: the project list failing
    // became `return []`, which the caller printed as "no deployment in any
    // project this login can see" — a sentence about a list nobody obtained.
    const failed = discoverDeployments({
      gcloud: gcloud({ ok: false, stderr: 'gcloud is not on your PATH.' }),
    });

    await expect(failed).rejects.toThrow(/not on your PATH/);
  });

  test('a login that genuinely holds no projects is an empty list, not an error', async () => {
    expect(await discoverDeployments({ gcloud: gcloud({ ok: true, stdout: '' }) })).toEqual([]);
  });
});
