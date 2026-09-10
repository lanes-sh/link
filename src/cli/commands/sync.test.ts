import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncTargets } from './sync.ts';

/**
 * Adopting a deployment this machine has no record of.
 *
 * The messages are the subject. Every one of them is read by someone who has
 * just been refused, on a machine that does not have the thing they are looking
 * for — so a message that blames the wrong cause sends them somewhere that
 * cannot work.
 */

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((one) => rm(one, { recursive: true, force: true })));
});

/**
 * A throwaway workspace, and the env var pointing at it.
 *
 * `syncTargets` calls `resolveWorkspaceRoot()` with no argument, and this used
 * to be the only thing standing between the suite and `~/.lanes-link` — the
 * operator's real profiles, credentials and audit log. Dev mode moved that
 * floor: a checkout resolves to `~/.lanes-dev/link` and cannot reach the real
 * root at all. This helper stays because `sync` *writes*, and a test that writes
 * should name where.
 */
async function workspace(declares = '{}'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-sync-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), `contract: 5\nworkspaces: ${declares}\n`);
  return root;
}

/** A second directory standing in for the bucket, since a path is a workspace too. */
async function remote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lanes-link-remote-'));
  roots.push(dir);
  await writeFile(
    join(dir, 'workspaces.yaml'),
    'contract: 5\nworkspaces:\n  cloud:\n' +
      '    credentials: { adapter: file }\n' +
      '    storage: { adapter: filesystem }\n',
  );
  return dir;
}

const failing = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('when the bucket cannot be read', () => {
  test('missing credentials are named, rather than blamed on the bucket', async () => {
    await workspace();

    const message = await failing(
      syncTargets({ target: 'cloud', from: 'gs://your-bucket' } as never, {
        probe: async () => ({
          kind: 'unreadable',
          reason: 'No Google credentials found. Run `gcloud auth application-default login`.',
          credentials: true,
        }),
      }),
    );

    expect(message).toContain('could not be read');
    expect(message).toContain('application-default login');
    // The sentence the old text got most wrong: --discover runs the same chain,
    // so recommending it here sent the reader somewhere that cannot work.
    expect(message).toContain('--discover');
    expect(message).toMatch(/would not get further|same credentials/);
  });

  test('a permission failure quotes the cause and does not offer a login', async () => {
    await workspace();

    const message = await failing(
      syncTargets({ target: 'cloud', from: 'gs://your-bucket' } as never, {
        probe: async () => ({
          kind: 'unreadable',
          reason: 'Cannot read your-bucket — grant roles/storage.objectAdmin.',
          credentials: false,
        }),
      }),
    );

    expect(message).toContain('objectAdmin');
    expect(message).not.toContain('application-default login');
  });
});

describe('when the bucket holds no workspace', () => {
  test('it names the file it looked for, and does not claim the bucket exists', async () => {
    await workspace();

    const message = await failing(
      syncTargets({ target: 'cloud', from: 'gs://your-bucket' } as never, {
        probe: async () => ({ kind: 'absent' }),
      }),
    );

    expect(message).toContain('workspaces.yaml');
    expect(message).not.toContain('lanes-link.yaml');
    // `has` cannot tell a missing object from a missing bucket, so the message
    // must not assert that the bucket is there.
    expect(message).toMatch(/does not exist reads exactly the same|check the name/i);
  });

  test('a bucket still on the old filename is offered a migration, not a refusal', async () => {
    await workspace();

    const message = await failing(
      syncTargets({ target: 'cloud', from: 'gs://your-bucket' } as never, {
        probe: async () => ({ kind: 'legacy' }),
      }),
    );

    expect(message).toContain('lanes-link.yaml');
    expect(message).toContain('deploy');
    expect(message).not.toMatch(/holds no workspace|does not hold a workspace/);
  });
});

describe('when nothing records where the target lives', () => {
  test('it names the file it read, and says naming the bucket is a one-off', async () => {
    const root = await workspace();

    const message = await failing(syncTargets({ target: 'cloud' } as never, {}));

    expect(message).toContain(join(root, 'workspaces.yaml'));
    expect(message).not.toContain('lanes-link.yaml');
    expect(message).toMatch(/once/i);
  });

  test('it suggests one spelling of the command, not two', async () => {
    await workspace();

    const message = await failing(syncTargets({ target: 'cloud' } as never, {}));
    const spellings = new Set([...message.matchAll(/lanes link sync (\w+)/g)].map((m) => m[1]));

    expect([...spellings]).toEqual(['workspaces']);
  });
});

describe('when this machine is already inside the workspace', () => {
  test('it does not demand --from for a workspace that declares the target itself', async () => {
    // `at` is set only on a pointer, so a root that *declares* cloud fell
    // through to "nothing says where cloud lives" while standing in it.
    await workspace(
      '\n  cloud:\n' +
        '    credentials: { adapter: file }\n' +
        '    storage: { adapter: filesystem }',
    );

    const message = await failing(syncTargets({ target: 'cloud' } as never, {}));

    expect(message).toMatch(/nothing to adopt|already/i);
    expect(message).not.toMatch(/If you know the bucket/);
  });
});

describe('adopting one', () => {
  test('the pointer is written, and only the pointer', async () => {
    const root = await workspace();
    const dir = await remote();

    await syncTargets({ target: 'cloud', from: dir } as never, {});

    expect(await readFile(join(root, 'workspaces.yaml'), 'utf8')).toContain(`at: ${dir}`);
  });

  test('--dry-run leaves the file exactly as it was', async () => {
    const root = await workspace();
    const dir = await remote();
    const before = await readFile(join(root, 'workspaces.yaml'), 'utf8');

    await syncTargets({ target: 'cloud', from: dir, dryRun: true } as never, {});

    expect(await readFile(join(root, 'workspaces.yaml'), 'utf8')).toBe(before);
  });

  test('--prefer is refused by name rather than ignored', async () => {
    await workspace();

    const message = await failing(
      syncTargets({ target: 'cloud', prefer: 'remote' } as never, {}),
    );

    expect(message).toContain('--prefer');
  });
});
