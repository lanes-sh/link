import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readConnections, parseConfig } from '#profile';
import { createProfile } from './profile.ts';
import { addIdentity, identityList, readIdentity, removeIdentity } from './identity.ts';

/**
 * `lanes link identity`.
 *
 * The property under test is not the wording, it is that declaring an identity
 * *makes it readable*. An `identity` block alone is inert:
 * `allowedConnections` returns nothing for a provider with no connection row
 * before it ever consults policy, so the surface is absent from `tools/list`
 * with nothing saying why. An operator would be looking at a file that says
 * exactly what they meant and an agent that cannot see a word of it — which is
 * the failure `setup` already had once, and the reason `add` provisions.
 *
 * The other half is that the three edits are one save. `validateConfig` refuses
 * an allow rule naming a provider with no connection, so a run that wrote the
 * rule and stopped would leave a profile that no longer loads at all.
 */

/**
 * Named on every call, because nothing falls back any more (ADR-037).
 *
 * `identity list` needs only the profile and `identity add` needs both, but the
 * commands take a flag bag either way — so one constant here rather than two
 * that would drift.
 */
const WHERE = { profile: 'personal', target: 'local' } as const;

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-identity-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await createProfile('personal', { targets: ['local'] });
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** The profile as it is on disk, parsed the way the endpoint parses it. */
async function onDisk(root: string): Promise<ReturnType<typeof parseConfig>['config']> {
  const text = await Bun.file(join(root, 'profiles', 'personal', 'profile.yaml')).text();
  return parseConfig(text).config;
}

/** Everything written to stdout while `body` runs. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }

  return captured;
}

describe('declaring an identity makes it readable', () => {
  test('the first entry provisions the connection and the grant', async () => {
    const root = await workspace();

    const { added } = await addIdentity('name', 'Ada', { ...WHERE, note: 'for papers' });

    expect(added.provisioned).toEqual([
      'connections.yaml += identity.main',
      'grants += identity.main',
      'grants[].allow += identity.*',
    ]);

    const config = await onDisk(root);
    expect(config.identity).toEqual([{ kind: 'name', value: 'Ada', note: 'for papers' }]);
    // The row is in the workspace and the grant is in the profile (ADR-057), and
    // `identity add` writes both or neither — a grant naming a connection that
    // does not exist is refused at load.
    expect((await readConnections(root)).connections.some((row) => row.provider === 'identity')).toBe(
      true,
    );
    expect(
      config.grants.some(
        (grant) =>
          grant.connection === 'identity.main' &&
          grant.allow.some((rule) => rule.capability === 'identity.*'),
      ),
    ).toBe(true);
  });

  test('a second entry provisions nothing, because there is nothing left to do', async () => {
    await workspace();
    await addIdentity('name', 'Ada', WHERE);

    const { added } = await addIdentity('email', 'ada@example.com', WHERE);

    expect(added.provisioned).toEqual([]);
    expect(added.total).toBe(2);
  });

  test('what lands on disk still loads', async () => {
    // The reason the three edits are one save. An allow rule naming a provider
    // with no connection is refused by `validateConfig`, so a half-applied run
    // would leave a file the endpoint cannot open — and `parseConfig` here is
    // the same call that would then fail.
    const root = await workspace();
    await addIdentity('name', 'Ada', { ...WHERE, note: 'for papers' });

    expect(async () => await onDisk(root)).not.toThrow();
  });

  test('the profile reports itself readable once both halves are there', async () => {
    await workspace();

    expect((await readIdentity(WHERE)).listing.reachable).toBe(false);
    await addIdentity('name', 'Ada', WHERE);
    expect((await readIdentity(WHERE)).listing.reachable).toBe(true);
  });
});

describe('what it refuses', () => {
  test('the same kind and value twice, before writing anything', async () => {
    const root = await workspace();
    await addIdentity('name', 'Ada', { ...WHERE, note: 'for papers' });

    await expect(addIdentity('name', 'Ada', { ...WHERE, note: 'for code' })).rejects.toThrow(
      /already declares name "Ada"/,
    );

    // The note that was already there survived the refusal.
    expect((await onDisk(root)).identity).toEqual([
      { kind: 'name', value: 'Ada', note: 'for papers' },
    ]);
  });

  test('removing something that was never declared', async () => {
    await workspace();

    await expect(removeIdentity('name', 'Nobody', WHERE)).rejects.toThrow(/does not declare name/);
  });
});

describe('removing an entry', () => {
  test('takes out the named one and leaves the rest in order', async () => {
    const root = await workspace();
    await addIdentity('name', 'Ada', WHERE);
    await addIdentity('name', 'A. Lovelace', WHERE);
    await addIdentity('email', 'ada@example.com', WHERE);

    const { removed, remaining } = await removeIdentity('name', 'Ada', WHERE);

    expect(removed.value).toBe('Ada');
    expect(remaining).toBe(2);
    expect((await onDisk(root)).identity.map((entry) => entry.value)).toEqual([
      'A. Lovelace',
      'ada@example.com',
    ]);
  });

  test('leaves the grant behind when the last entry goes', async () => {
    // Revoking it here would mean the next `identity add` silently re-widens
    // policy. A surface reporting "nothing declared" is the honest state, and
    // it is the one an operator can see.
    const root = await workspace();
    await addIdentity('name', 'Ada', WHERE);

    await removeIdentity('name', 'Ada', WHERE);

    const config = await onDisk(root);
    expect(config.identity).toEqual([]);
    expect((await readConnections(root)).connections.some((row) => row.provider === 'identity')).toBe(
      true,
    );
    expect(config.grants.some((grant) => grant.allow.some((rule) => rule.capability === 'identity.*'))).toBe(true);
  });
});

describe('identity list --json', () => {
  test('puts nothing but JSON on stdout', async () => {
    await workspace();
    await addIdentity('name', 'Ada', { ...WHERE, note: 'for papers' });

    const written = await captureStdout(() => identityList({ ...WHERE, json: true }));

    // The assertion is the parse: `announce` runs first on every command,
    // deliberately, and that line in front of a document is the difference
    // between a parser and a crash.
    const parsed = JSON.parse(written) as {
      profile: string;
      reachable: boolean;
      entries: { kind: string; value: string; note?: string }[];
    };
    expect(parsed.profile).toBe('personal');
    expect(parsed.reachable).toBe(true);
    expect(parsed.entries).toEqual([{ kind: 'name', value: 'Ada', note: 'for papers' }]);
  });

  test('a profile declaring nothing still emits a document rather than prose', async () => {
    await workspace();

    const written = await captureStdout(() => identityList({ ...WHERE, json: true }));

    expect(JSON.parse(written)).toMatchObject({ entries: [], reachable: false });
  });
});
