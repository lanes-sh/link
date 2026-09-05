import { describe, expect, test } from 'bun:test';
import { isRemoteWorkspace, workspaceFiles } from './files.ts';

/**
 * Which backing a workspace root names.
 *
 * Three schemes now, and the third is the one this file exists to pin. A
 * `lanes://` root has to be *remote* — every caller that asks
 * `isRemoteWorkspace` is asking "can I treat this as a filesystem path", and
 * the answer for a managed workspace is no. Getting that wrong does not fail
 * loudly: it produces a directory literally named `lanes:` beside whatever the
 * process's working directory happens to be.
 */

describe('a workspace root', () => {
  test('a directory is not remote', () => {
    expect(isRemoteWorkspace('/Users/someone/.lanes-link')).toBe(false);
    expect(isRemoteWorkspace('./relative')).toBe(false);
  });

  test('a bucket is remote', () => {
    expect(isRemoteWorkspace('gs://your-bucket')).toBe(true);
    expect(isRemoteWorkspace('gs://your-bucket/prefix')).toBe(true);
  });

  test('a managed workspace is remote', () => {
    expect(isRemoteWorkspace('lanes://ws-aaa')).toBe(true);
  });
});

describe('opening a workspace root', () => {
  test('a managed root is served by the API rather than the filesystem', async () => {
    // Nothing registered a credential here, so the lanes adapter refuses. That
    // refusal is the proof: a filesystem store would have happily reported
    // absence from a directory named `lanes:`.
    await expect(workspaceFiles('lanes://ws-aaa').get('connections.yaml')).rejects.toThrow(
      /credential is registered/i,
    );
  });

  test('a managed root naming no workspace is refused', () => {
    expect(() => workspaceFiles('lanes://')).toThrow(/workspace/i);
  });
});
