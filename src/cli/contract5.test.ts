import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { migrateToContract5, needsContract5 } from './contract5.ts';

/**
 * Contract 4 to contract 5, against a real workspace on disk.
 *
 * Written against outcomes rather than internals, for the reason
 * `contract4.test.ts` states: the defects the last two migrations shipped all
 * lost or misrouted something *while reporting success*.
 *
 * The one this migration can get wrong is the subject. A row bound to the wrong
 * one is worse than no row — it looks issued and reaches nothing, or reaches
 * somebody else's profiles — so most of what is asserted here is about where
 * the subject came from and what happens when there is none.
 */

const homes: string[] = [];

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

const PROFILE = (name: string, members: string, tokenRef?: string): string =>
  `contract: 4\ninstance:\n  profile: ${name}\n` +
  `auth:\n  mode: bearer\n${tokenRef ? `  token_ref: ${tokenRef}\n` : ''}` +
  `grants: []\nmembers:\n${members}`;

async function workspace(
  profiles: Record<string, { members: string; tokenRef?: string }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-c5-'));
  homes.push(root);

  await writeFile(
    join(root, 'workspaces.yaml'),
    'contract: 4\nworkspaces:\n  local:\n    credentials: { adapter: file }\n' +
      '    storage: { adapter: filesystem }\n',
  );
  await writeFile(join(root, 'connections.yaml'), 'contract: 4\nconnections: []\noauth_apps: {}\n');

  for (const [name, spec] of Object.entries(profiles)) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    await writeFile(
      join(root, 'profiles', name, 'profile.yaml'),
      PROFILE(name, spec.members, spec.tokenRef),
    );
  }

  return root;
}

const read = (root: string, key: string): Promise<string> => readFile(join(root, key), 'utf8');

const OWNER = '  - { subject: lanes:ownersubject, role: owner }\n';
const MEMBER = '  - { subject: lanes:membersubject, role: member }\n';

interface Rows {
  tokens?: { id: string; subject: string; ref: string; label?: string }[];
}

describe('what contract 5 moves', () => {
  test('the token becomes a workspace row naming the profile owner', async () => {
    const root = await workspace({ personal: { members: OWNER } });

    expect(await needsContract5(root)).toBe(true);
    const migration = await migrateToContract5(root);

    const connections = parse(await read(root, 'connections.yaml')) as Rows;
    expect(connections.tokens).toHaveLength(1);
    expect(connections.tokens?.[0]?.subject).toBe('lanes:ownersubject');

    // **The ref is not renamed.** A row may name any ref, and re-keying means
    // copying a live credential then deleting the original — two writes and a
    // window where a deployed revision reads neither.
    expect(connections.tokens?.[0]?.ref).toBe('profile/token');

    const profile = parse(await read(root, 'profiles/personal/profile.yaml')) as {
      contract: number;
      auth: Record<string, unknown>;
    };
    expect(profile.contract).toBe(5);
    expect(profile.auth['token_ref']).toBeUndefined();
    expect(migration.issued).toEqual([{ id: 'tok1', subject: 'lanes:ownersubject' }]);
  });

  test('the registry is stamped too, and never ahead of the profiles', async () => {
    // `isUnmigrated` reads the registry's contract and nothing else, so a stamp
    // ahead of the profiles reports a finished migration with a step to run.
    const root = await workspace({ personal: { members: OWNER } });

    await migrateToContract5(root);

    const registry = parse(await read(root, 'workspaces.yaml')) as { contract: number };
    const profile = parse(await read(root, 'profiles/personal/profile.yaml')) as {
      contract: number;
    };
    expect(registry.contract).toBe(5);
    expect(registry.contract).toBe(profile.contract);
  });

  test('profiles sharing the template default get one row, not one each', async () => {
    // The whole reason this contract exists: `token_ref` defaulted to the same
    // constant for every profile out of one per-workspace store, so "three
    // profiles' tokens" were always one credential.
    const root = await workspace({
      personal: { members: OWNER },
      work: { members: OWNER },
      shared: { members: OWNER },
    });

    await migrateToContract5(root);

    const connections = parse(await read(root, 'connections.yaml')) as Rows;
    expect(connections.tokens).toHaveLength(1);

    for (const name of ['personal', 'work', 'shared']) {
      const profile = parse(await read(root, `profiles/${name}/profile.yaml`)) as {
        contract: number;
      };
      expect(profile.contract).toBe(5);
    }
  });

  test('a profile that overrode token_ref keeps its own credential', async () => {
    // Rare, and a real separate credential: dropping it would take a working
    // endpoint down.
    const root = await workspace({
      personal: { members: OWNER },
      work: { members: OWNER, tokenRef: 'other/token' },
    });

    await migrateToContract5(root);

    const refs = (parse(await read(root, 'connections.yaml')) as Rows).tokens?.map((r) => r.ref);
    expect(refs?.sort()).toEqual(['other/token', 'profile/token']);
  });

  test('an owner is preferred over a plain member', async () => {
    // `owner` is who may edit the member list (ADR-060), so it is the one role
    // that cannot have been delegated a narrower reach than the token had.
    const root = await workspace({ personal: { members: MEMBER + OWNER } });

    await migrateToContract5(root);

    const rows = (parse(await read(root, 'connections.yaml')) as Rows).tokens;
    expect(rows?.[0]?.subject).toBe('lanes:ownersubject');
  });

  test('a member with no owner is still somebody this belonged to', async () => {
    const root = await workspace({ personal: { members: MEMBER } });

    await migrateToContract5(root);

    const rows = (parse(await read(root, 'connections.yaml')) as Rows).tokens;
    expect(rows?.[0]?.subject).toBe('lanes:membersubject');
  });

  test('a passed subject wins, which is what `update` hands it', async () => {
    const root = await workspace({ personal: { members: OWNER } });

    await migrateToContract5(root, { apply: true, subject: 'lanes:signedinnow' });

    const rows = (parse(await read(root, 'connections.yaml')) as Rows).tokens;
    expect(rows?.[0]?.subject).toBe('lanes:signedinnow');
  });
});

describe('what it refuses rather than guesses', () => {
  test('a workspace whose profiles list nobody stops, and says which command fixes it', async () => {
    // `members: []` is what contract 3 wrote when it ran signed out, and it is
    // legitimate — default deny on the identity axis. What it is not is a
    // subject, and a row bound to nobody looks issued and reaches nothing.
    const root = await workspace({ personal: { members: '  []\n' } });

    await expect(migrateToContract5(root)).rejects.toThrow(/no profile holding it lists an owner/);
    await expect(migrateToContract5(root)).rejects.toThrow(/members add --me/);

    // And it left the file alone: a refusal that half-migrated would be worse
    // than the state it refused.
    const profile = parse(await read(root, 'profiles/personal/profile.yaml')) as {
      contract: number;
    };
    expect(profile.contract).toBe(4);
  });
});

describe('reruns and previews', () => {
  test('a second run finds nothing to do', async () => {
    const root = await workspace({ personal: { members: OWNER } });

    await migrateToContract5(root);
    expect(await needsContract5(root)).toBe(false);

    const again = await migrateToContract5(root);
    expect(again.alreadyCurrent).toBe(true);
    expect((parse(await read(root, 'connections.yaml')) as Rows).tokens).toHaveLength(1);
  });

  test('a row already written is not written twice, which is what an interruption leaves', async () => {
    // The row is written before the profiles are stamped, so a crash between
    // the two leaves a workspace whose rerun must not duplicate it.
    const root = await workspace({ personal: { members: OWNER } });
    await writeFile(
      join(root, 'connections.yaml'),
      'contract: 4\nconnections: []\noauth_apps: {}\n' +
        'tokens:\n  - { id: tok1, subject: lanes:ownersubject, ref: profile/token }\n',
    );

    await migrateToContract5(root);

    expect((parse(await read(root, 'connections.yaml')) as Rows).tokens).toHaveLength(1);
  });

  test('a preview writes nothing and still says what it would do', async () => {
    const root = await workspace({ personal: { members: OWNER } });

    const preview = await migrateToContract5(root, { apply: false });

    expect(preview.alreadyCurrent).toBe(false);
    expect(preview.changes.join('\n')).toContain('tokens += a row for "profile/token"');
    expect(preview.changes.join('\n')).toContain('auth.token_ref removed');
    expect((parse(await read(root, 'connections.yaml')) as Rows).tokens ?? []).toHaveLength(0);
    expect(await needsContract5(root)).toBe(true);
  });
});
