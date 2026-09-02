import { describe, expect, test } from 'bun:test';
import type { SecretRef, SecretStore } from '#secrets';
import type { BlobMetadata, BlobStore } from '#stores/blobs';
import type { Prompter } from '../../prompt.ts';
import type { RemovalItem, RemovalPlan } from './removal.ts';
import {
  confirmedByName,
  executeRemoval,
  renderOutcome,
  type RemovalOutcome,
  type RunDeps,
} from './remove.ts';

/**
 * Performing a removal, and being honest about the parts that did not happen.
 *
 * Best effort by choice: a target whose project has been deleted must not be
 * able to strand a profile on the machine forever. The price is that a failed
 * deletion leaves a live credential behind, so everything here is about making
 * that visible and recoverable rather than quiet.
 */

function store(refs: string[] = [], failOn?: string): SecretStore & { deleted: string[] } {
  const held = new Map(refs.map((ref) => [ref, 'value']));
  const deleted: string[] = [];
  return {
    deleted,
    get: async (ref) => held.get(ref) ?? null,
    set: async () => {},
    has: async (ref) => held.has(ref),
    delete: async (ref) => {
      if (ref === failOn) throw new Error('permission denied');
      deleted.push(ref);
      held.delete(ref);
    },
    list: async () => [...held.keys()] as SecretRef[],
  };
}

function blobs(keys: string[] = [], failOn?: string): BlobStore & { deleted: string[] } {
  const held = new Set(keys);
  const deleted: string[] = [];
  return {
    deleted,
    put: async () => {},
    get: async () => null,
    has: async (key) => held.has(key),
    delete: async (key) => {
      if (key === failOn) throw new Error('bucket is gone');
      deleted.push(key);
      held.delete(key);
    },
    list: async () =>
      [...held].map((key) => ({ key, size: 0, modifiedAt: new Date(0) })) as BlobMetadata[],
  };
}

const item = (over: Partial<RemovalItem>): RemovalItem =>
  ({ target: 'local', kind: 'secret', id: 'gmail/someone', ...over }) as RemovalItem;

const plan = (items: RemovalItem[]): RemovalPlan => ({
  profile: 'personal',
  items,
  untouched: [],
  warnings: [],
});

function deps(over: Partial<RunDeps> = {}): RunDeps & { removedConfig: string[]; cleared: number } {
  const removedConfig: string[] = [];
  let cleared = 0;
  return {
    removedConfig,
    get cleared() {
      return cleared;
    },
    openSecrets: async () => store(['gmail/someone']),
    openBlobs: async () => blobs(['state.kv/a']),
    removeConfig: async (path: string) => void removedConfig.push(path),
    removeDirectory: async (path: string) => void removedConfig.push(path),
    clearDefaultProfile: async () => void (cleared += 1),
    ...over,
  } as RunDeps & { removedConfig: string[]; cleared: number };
}

describe('executeRemoval', () => {
  test('removes every item when every store accepts', async () => {
    const d = deps();
    const outcome = await executeRemoval(
      plan([
        item({ kind: 'secret', id: 'gmail/someone' }),
        item({ kind: 'blob', id: 'state.kv/a' }),
        item({ target: null, kind: 'config', id: '/ws/profiles/personal/profile.yaml' }),
      ]),
      d,
    );

    expect(outcome.survived).toBe(0);
    expect(outcome.results.every((r) => r.status === 'removed')).toBe(true);
    expect(d.removedConfig).toContain('/ws/profiles/personal/profile.yaml');
  });

  test('a failing delete does not stop the ones after it', async () => {
    const secrets = store(['a/one', 'a/two'], 'a/one');
    const outcome = await executeRemoval(
      plan([item({ kind: 'secret', id: 'a/one' }), item({ kind: 'secret', id: 'a/two' })]),
      deps({ openSecrets: async () => secrets }),
    );

    expect(outcome.survived).toBe(1);
    expect(secrets.deleted).toContain('a/two');
    expect(outcome.results[0]?.status).toBe('failed');
    expect(outcome.results[0]?.error).toMatch(/permission denied/);
  });

  test('a survivor carries the command that finishes the job by hand', async () => {
    const outcome = await executeRemoval(
      plan([item({ kind: 'secret', id: 'a/one' })]),
      deps({
        openSecrets: async () => store(['a/one'], 'a/one'),
        retry: () => 'gcloud secrets delete a__one --project my-project',
      }),
    );

    expect(outcome.results[0]?.retry).toContain('gcloud secrets delete');
  });

  test('the config is kept when anything survived, so the command can be re-run', async () => {
    // Config-last exists because it is the only record of where everything
    // lives. Deleting it after a failure would strand exactly the credential
    // that failed — the operator would be left with a live secret and nothing
    // that knows where it is. Keeping it makes the retry `profile remove`.
    const d = deps({ openSecrets: async () => store(['a/one'], 'a/one') });
    const outcome = await executeRemoval(
      plan([
        item({ kind: 'secret', id: 'a/one' }),
        item({ target: null, kind: 'workspace-key', id: 'default_profile' }),
        item({ target: null, kind: 'config', id: '/ws/profiles/personal/profile.yaml' }),
      ]),
      d,
    );

    expect(d.removedConfig).toHaveLength(0);
    expect(d.cleared).toBe(0);
    expect(outcome.results.filter((r) => r.status === 'kept')).toHaveLength(2);
  });

  test('deleting what is already gone is removal, not failure', async () => {
    // The GCP adapter treats a 404 as a no-op on purpose; a second run of the
    // same removal should report success rather than invent a problem.
    const outcome = await executeRemoval(
      plan([item({ kind: 'secret', id: 'not/there' })]),
      deps({ openSecrets: async () => store([]) }),
    );

    expect(outcome.survived).toBe(0);
  });

  test('a store that will not open fails its items and spares the rest', async () => {
    const outcome = await executeRemoval(
      plan([
        item({ target: 'cloud', kind: 'secret', id: 'a/one' }),
        item({ target: 'local', kind: 'blob', id: 'state.kv/a' }),
      ]),
      deps({
        openSecrets: async () => {
          throw new Error('no credentials for this project');
        },
      }),
    );

    expect(outcome.results[0]?.status).toBe('failed');
    expect(outcome.results[1]?.status).toBe('removed');
  });

  test('opens each store once, however many items it holds', async () => {
    let opened = 0;
    const shared = store(['a/one', 'a/two']);
    await executeRemoval(
      plan([item({ kind: 'secret', id: 'a/one' }), item({ kind: 'secret', id: 'a/two' })]),
      deps({
        openSecrets: async () => {
          opened += 1;
          return shared;
        },
      }),
    );

    expect(opened).toBe(1);
  });
});

// --- renderOutcome ---------------------------------------------------------

function captured(body: () => void): { out: string; err: string } {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string) => ((out += chunk), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string) => ((err += chunk), true);
  try {
    body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = outWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = errWrite;
  }
  return { out, err };
}

const outcome = (over: Partial<RemovalOutcome> = {}): RemovalOutcome => ({
  profile: 'personal',
  results: [{ item: item({ kind: 'secret', id: 'gmail/someone' }), status: 'removed' }],
  survived: 0,
  ...over,
});

describe('renderOutcome', () => {
  test('a clean run says so, and leaves the exit code alone', () => {
    const before = process.exitCode;
    const { out } = captured(() => renderOutcome(outcome()));

    expect(out).toMatch(/personal/);
    expect(process.exitCode).toBe(before);
  });

  test('a survivor is named with the command that finishes it', () => {
    const { out } = captured(() =>
      renderOutcome(
        outcome({
          results: [
            {
              item: item({ kind: 'secret', id: 'a/one' }),
              status: 'failed',
              error: 'permission denied',
              retry: 'gcloud secrets delete a__one --project my-project',
            },
          ],
          survived: 1,
        }),
      ),
    );

    expect(out).toContain('a/one');
    expect(out).toContain('permission denied');
    expect(out).toContain('gcloud secrets delete a__one');

    process.exitCode = 0;
  });

  test('anything surviving sets a non-zero exit code', () => {
    // Silence would read as success to a script, and the thing left behind is
    // a live credential.
    process.exitCode = 0;
    captured(() =>
      renderOutcome(
        outcome({
          results: [{ item: item({ kind: 'secret', id: 'a/one' }), status: 'failed' }],
          survived: 1,
        }),
      ),
    );

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test('a kept config says the removal can simply be run again', () => {
    process.exitCode = 0;
    const { out } = captured(() =>
      renderOutcome(
        outcome({
          results: [
            { item: item({ kind: 'secret', id: 'a/one' }), status: 'failed', error: 'nope' },
            { item: item({ target: null, kind: 'config', id: '/ws/p.yaml' }), status: 'kept' },
          ],
          survived: 2,
        }),
      ),
    );

    expect(out).toMatch(/again|re-run|rerun/i);
    process.exitCode = 0;
  });
});

// --- confirmedByName -------------------------------------------------------

function prompter(answer: string, interactive = true): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    interactive,
    ask: async (question: string) => {
      asked.push(question);
      return answer;
    },
    askSecret: async () => '',
    confirm: async () => true,
  };
}

describe('confirmedByName', () => {
  test('--yes proceeds without asking anything', async () => {
    const p = prompter('');

    expect(await confirmedByName('personal', { yes: true, prompter: p })).toBe(true);
    expect(p.asked).toHaveLength(0);
  });

  test('refuses when there is nobody to ask, and says how to proceed', async () => {
    // Fails closed. The same shape `agreed()` uses, for the same reason: a
    // non-interactive run must not be able to default its way into a deletion.
    await expect(
      confirmedByName('personal', { prompter: prompter('personal', false) }),
    ).rejects.toThrow(/--yes/);
  });

  test('the wrong name does not proceed', async () => {
    expect(await confirmedByName('personal', { prompter: prompter('persona') })).toBe(false);
  });

  test('the exact name proceeds', async () => {
    expect(await confirmedByName('personal', { prompter: prompter('personal') })).toBe(true);
  });

  test('surrounding whitespace is forgiven, a different name is not', async () => {
    expect(await confirmedByName('personal', { prompter: prompter('  personal \n') })).toBe(true);
    expect(await confirmedByName('personal', { prompter: prompter('work') })).toBe(false);
  });
});
