import { workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout } from '#profile';
import type { ConnectOptions } from '../index.ts';
import { NOTHING, type ConnectOutcome } from '../outcome.ts';
import { connectCustom, type ConnectCustomOptions } from './index.ts';

/**
 * The orchestration: what is refused, what is written, and in which order.
 *
 * `runConnect` is replaced throughout, because everything worth asserting here
 * happens before it — the whole design of this command is that anything that can
 * be refused is refused before a file exists, so that a failure never leaves a
 * malformed manifest behind. One bad file in `providers.d/` makes
 * `loadWorkspaceProviders` throw for the entire directory, which breaks `connect`,
 * `doctor`, `plan`, `status`, `start` and `deploy` for that profile — and
 * `check`, whose whole job is catching that, does not read the directory at all.
 */

const PROFILE = `contract: 3

instance:
  profile: personal
  port: 7337

`;

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-connect-custom-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local'], {defaultProfile: 'personal'}));
  await writeProfileFixture(root, 'personal', PROFILE);
  return root;
}

afterEach(() => {
  process.exitCode = 0;
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Stands in for `runConnect`, recording that it was reached and with what. */
function handOff(): {
  calls: string[];
  connectWith: (target: string, options: ConnectOptions) => Promise<ConnectOutcome>;
} {
  const calls: string[] = [];
  return {
    calls,
    connectWith: async (target) => {
      calls.push(target);
      return { ...NOTHING, ok: true, key: `${target}.main` };
    },
  };
}

const declaring = (extra: Partial<ConnectCustomOptions> = {}): ConnectCustomOptions => ({
  profile: 'personal',
  target: 'local',
  quiet: true,
  json: true,
  connector: 'mcp',
  auth: 'none',
  endpoint: 'https://mcp.example.com/mcp',
  name: 'Thing',
  ...extra,
});

const manifestAt = (root: string, id: string) =>
  readFile(join(root, layout.providers(), `${id}.yaml`), 'utf8');

describe('declaring and connecting in one command', () => {
  test('writes the manifest and then hands off', async () => {
    const root = await workspace();
    const { calls, connectWith } = handOff();

    await connectCustom('thing', declaring({ connectWith }));

    expect(await manifestAt(root, 'thing')).toMatch(/id: thing/);
    expect(calls).toEqual(['thing']);
  });

  test('the manifest is written before the hand-off, because the registry reads it', async () => {
    // `runConnect` opens the runtime on its first line, and the registry that
    // opening builds is what reads `providers.d/`. Written afterwards, the
    // provider would be unknown to the connect that was supposed to connect it.
    const root = await workspace();
    let existedAtHandOff = false;

    await connectCustom(
      'thing',
      declaring({
        connectWith: async (target) => {
          existedAtHandOff = await manifestAt(root, 'thing').then(
            () => true,
            () => false,
          );
          return { ...NOTHING, ok: true, key: target };
        },
      }),
    );

    expect(existedAtHandOff).toBe(true);
  });
});

describe('a declaration already on disk', () => {
  const first = declaring();

  test('identical answers are a repair, not a refusal', async () => {
    // The common case is "the manifest was fine, the token was wrong", and the
    // operator re-runs the whole line. Refusing there would be useless.
    const root = await workspace();
    await connectCustom('thing', { ...first, connectWith: handOff().connectWith });
    const before = await manifestAt(root, 'thing');

    const second = handOff();
    await connectCustom('thing', { ...first, connectWith: second.connectWith });

    expect(await manifestAt(root, 'thing')).toBe(before);
    expect(second.calls).toEqual(['thing']);
    expect(process.exitCode).not.toBe(1);
  });

  test('different answers refuse, and change nothing', async () => {
    const root = await workspace();
    await connectCustom('thing', { ...first, connectWith: handOff().connectWith });
    const before = await manifestAt(root, 'thing');

    const second = handOff();
    await connectCustom('thing', {
      ...first,
      endpoint: 'https://other.example.com/mcp',
      connectWith: second.connectWith,
    });

    expect(await manifestAt(root, 'thing')).toBe(before);
    expect(second.calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test('--replace-manifest is what rewrites it', async () => {
    const root = await workspace();
    await connectCustom('thing', { ...first, connectWith: handOff().connectWith });

    const second = handOff();
    await connectCustom('thing', {
      ...first,
      endpoint: 'https://other.example.com/mcp',
      replaceManifest: true,
      connectWith: second.connectWith,
    });

    expect(await manifestAt(root, 'thing')).toMatch(/other\.example\.com/);
    expect(second.calls).toEqual(['thing']);
  });
});

describe('an id that cannot work', () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ['custom', 'the second word of this command', /never connected/],
    ['gmail', 'a built-in it would shadow', /already built in/],
    ['memory', 'reserved for the owner layer', /reserved for what this endpoint provides/],
    ['My-Thing', 'not a legal identifier', /lowercase, start with a letter/],
  ];

  test.each(cases)('%s is refused: %s', async (id, _why, message) => {
    await workspace();
    const { calls, connectWith } = handOff();

    await expect(connectCustom(id, declaring({ connectWith }))).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  test('a hyphen is refused with the spelling that would work', async () => {
    await workspace();
    await expect(connectCustom('my-thing', declaring())).rejects.toThrow(/"my_thing"/);
  });
});

describe('a workspace in a bucket', () => {
  test('is refused, naming what to do instead', async () => {
    // A manifest is read from the workspace and written to the filesystem, and a
    // bucket only does the first. Not a limitation of this command: ADR-007 says
    // a deployed revision never rewrites its own config.
    const previous = process.env['LANES_LINK_HOME'];
    process.env['LANES_LINK_HOME'] = 'gs://your-bucket';

    try {
      await expect(connectCustom('thing', declaring())).rejects.toThrow(
        /manifest is written to a local filesystem/,
      );
    } finally {
      if (previous === undefined) delete process.env['LANES_LINK_HOME'];
      else process.env['LANES_LINK_HOME'] = previous;
    }
  });
});

describe('a run with nobody to ask', () => {
  test('refuses with every missing value, and writes nothing', async () => {
    const root = await workspace();
    const { calls, connectWith } = handOff();

    await connectCustom('thing', {
      profile: 'personal',
      target: 'local',
      quiet: true,
      json: true,
      nonInteractive: true,
      connector: 'http',
      auth: 'header',
      connectWith,
    });

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
    await expect(manifestAt(root, 'thing')).rejects.toThrow();
  });
});

describe('an unusable pairing never reaches the disk', () => {
  test('refused before the write, so nothing has to be cleaned up', async () => {
    const root = await workspace();
    const { calls, connectWith } = handOff();

    await expect(
      connectCustom(
        'thing',
        declaring({ connector: 'imap', auth: 'bearer', host: 'imap.example.com', connectWith }),
      ),
    ).rejects.toThrow(/Use --auth basic/);

    await expect(manifestAt(root, 'thing')).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
