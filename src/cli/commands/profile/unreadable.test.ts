import { afterAll, describe, expect, test } from 'bun:test';
import { connectionsYaml, profileYaml, workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeProfile } from './remove.ts';

/**
 * Removing a profile whose config will not load — issue #219.
 *
 * The defect was never the error. It was the leftover: `profile add` wrote a
 * name the contract refuses and then parsed it back, so the profile existed,
 * `listProfiles` showed it like any other, and every command that could have
 * taken it away resolved it first and died on the same parse. The only way out
 * was deleting the file by hand, or the bucket object on a deployed workspace.
 *
 * These are on disk rather than against injected stores, deliberately. The unit
 * seams in `remove.test.ts` and `removal.test.ts` prove the planner and the
 * executor behave; only a real directory proves the property the issue is about,
 * which is that afterwards there is nothing left.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

/** A workspace holding a healthy `personal`, and whatever `broken` is given. */
async function workspace(brokenBody: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-unreadable-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;

  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
  await writeFile(join(root, 'connections.yaml'), connectionsYaml());
  await writeProfileFixture(root, 'personal', profileYaml('personal'));
  await writeProfileFixture(root, 'broken', brokenBody);

  // Something in its blob tree, because a directory with only a config in it
  // would pass a weaker version of these tests than the ones that matter.
  await writeFile(join(root, 'profiles', 'broken', 'note.md'), 'a note');
  return root;
}

/** The document #219 actually produces: perfect YAML, a name the schema refuses. */
const REFUSED_NAME = profileYaml('my-profile');

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Silence the preview and the outcome; these assert against disk. */
async function quietly(body: () => Promise<void>): Promise<void> {
  const write = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (): boolean => true;
  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = write;
  }
}

describe('removing a profile whose config will not load', () => {
  test('the leftover is gone, and the sibling is untouched', async () => {
    const root = await workspace(REFUSED_NAME);
    const before = process.exitCode;

    await quietly(() =>
      removeProfile('broken', { target: 'local', yes: true, deleteData: true }),
    );

    // The property the issue is about. Everything else here is detail.
    expect(existsSync(join(root, 'profiles', 'broken'))).toBe(false);

    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);
    expect(await readFile(join(root, 'profiles', 'personal', 'profile.yaml'), 'utf8')).toContain(
      'profile: personal',
    );

    // **Exit 0, and this is the assertion that keys the whole exit-code rule.**
    // Every field of this document reads cleanly, so the removal named
    // everything it could have named and left nothing. Reporting failure here
    // would mean the cleanup script that hit #219 in the first place still
    // fails — on a profile that is now gone.
    expect(process.exitCode).toBe(before);
    process.exitCode = before;
  });

  test('a file that is not even YAML is still removable', async () => {
    // The proof there is one degraded path rather than two. `ConfigDocument`
    // throws here where it parsed above, and that is the only difference: every
    // field lands unread and the same code runs.
    const root = await workspace('contract: 5\ninstance:\n  profile: [\n');
    const before = process.exitCode;

    await quietly(() =>
      removeProfile('broken', { target: 'local', yes: true, deleteData: true }),
    );

    expect(existsSync(join(root, 'profiles', 'broken'))).toBe(false);
    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);

    // Non-zero, because nothing could be read: this removal cannot say whether
    // one of the refs it left behind was the profile's own. That is a different
    // outcome from the test above and must not share its exit code.
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });

  /**
   * The hazard the structural split exists to prevent.
   *
   * Catching `ConfigError` around the resolution would have been the small
   * change, and it would have read "you typed the wrong workspace" as "this
   * profile is broken" — then run a degraded removal to completion under
   * `--yes --delete-data`, in a workspace nobody meant. `locateProfile` catches
   * only the parse, so everything before it throws exactly as it always did.
   */
  test('a workspace that is not declared still refuses, and removes nothing', async () => {
    const root = await workspace(REFUSED_NAME);

    await expect(
      removeProfile('broken', { target: 'nowhere', yes: true, deleteData: true }),
    ).rejects.toThrow(/nowhere/);

    expect(existsSync(join(root, 'profiles', 'broken', 'profile.yaml'))).toBe(true);
    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);
  });

  test('a profile that does not exist still refuses, and removes nothing', async () => {
    const root = await workspace(REFUSED_NAME);

    await expect(
      removeProfile('ghost', { target: 'local', yes: true, deleteData: true }),
    ).rejects.toThrow(/ghost/);

    expect(existsSync(join(root, 'profiles', 'broken', 'profile.yaml'))).toBe(true);
    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);
  });

  test('--migrate-to is refused, and nothing has run when it is', async () => {
    const root = await workspace(REFUSED_NAME);

    await expect(
      removeProfile('broken', { target: 'local', yes: true, migrateTo: 'personal' }),
    ).rejects.toThrow(/will not move its bytes/);

    expect(existsSync(join(root, 'profiles', 'broken', 'profile.yaml'))).toBe(true);
    expect(existsSync(join(root, 'profiles', 'personal', 'profile.yaml'))).toBe(true);
  });
});
