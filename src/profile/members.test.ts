import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionsYaml, profileYaml, workspaceYaml, writeProfileFixture } from './testing.ts';
import { layout } from './layout.ts';
import { CONNECTIONS_FILE } from './workspace.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import {
  declaredMembers,
  workspaceMembers,
  INVENTORY_TTL_MS,
  MEMBERS_TTL_MS,
  STALE_CEILING_MS,
} from './members.ts';

/**
 * The one rule four credentials now share.
 *
 * These are the tests the rest of the change rests on, because every other part
 * of it assumes this module can tell three states apart that the code it
 * replaces could not: a subject **no profile names**, a profile that has been
 * **removed**, and a workspace this process **cannot read**. `listProfiles` and
 * `loadWorkspaceProfiles` answer all three with an empty list, which is fine
 * while an empty list only narrows a surface and fatal once it ends a session.
 */

// `subjectRef` wants `lanes:` and six to sixty-four alphanumerics, so the
// three-letter placeholders the pure-function tests use are not valid here.
const ONE = 'lanes:adalovelace';
const TWO = 'lanes:gracehopper';
const roots: string[] = [];

/** A workspace holding `connections.yaml` and whatever profiles a test names. */
async function workspace(
  profiles: readonly { name: string; members?: readonly string[] }[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-members-'));
  roots.push(root);

  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
  await writeFile(join(root, 'connections.yaml'), connectionsYaml());

  for (const profile of profiles) {
    await writeProfileFixture(
      root,
      profile.name,
      profileYaml(profile.name, { members: profile.members ?? [] }),
    );
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('who a workspace declares', () => {
  test('a subject reaches every profile whose members name them', async () => {
    const root = await workspace([
      { name: 'personal', members: [ONE] },
      { name: 'work', members: [ONE, TWO] },
      { name: 'other', members: [TWO] },
    ]);

    const members = workspaceMembers(root);

    expect([...(await members.profilesFor(ONE))].sort()).toEqual(['personal', 'work']);
    expect([...(await members.profilesFor(TWO))].sort()).toEqual(['other', 'work']);
  });

  test('a subject no profile names reaches nothing, and that is not an error', async () => {
    // The distinction the whole module exists for. Empty here is a *fact* about
    // the workspace, and the caller is entitled to act on it — which is what
    // lets an issued token treat it as a revocation. Every other way of
    // producing an empty list has to stay distinguishable from this one.
    const root = await workspace([{ name: 'personal', members: [ONE] }]);

    expect(await workspaceMembers(root).profilesFor(TWO)).toEqual([]);
  });

  test('declared, not served: a profile nothing has provisioned still names its members', async () => {
    // `membersOf` read the live runtime map, so a profile that failed to open
    // dropped out of it and its members looked like strangers — at the mint,
    // that refused the whole sign-in. Nothing here consults what opened, and
    // `mergeCapabilities` still filters reach by the served set, so this cannot
    // widen what a caller can actually touch.
    const root = await workspace([{ name: 'unprovisioned', members: [ONE] }]);

    expect(await workspaceMembers(root).profilesFor(ONE)).toEqual(['unprovisioned']);
  });
});

describe('telling removed from unreadable', () => {
  test('a removed profile drops out within the hot window', async () => {
    let clock = 1_000;
    const root = await workspace([
      { name: 'personal', members: [ONE] },
      { name: 'work', members: [ONE] },
    ]);
    const members = workspaceMembers(root, { now: () => clock });

    expect([...(await members.profilesFor(ONE))].sort()).toEqual(['personal', 'work']);

    await rm(join(root, layout.profileConfig('work')), { force: true });
    clock += MEMBERS_TTL_MS;

    // Absent is an answer: the config is gone, so its members lose it. No
    // listing was needed to find that out, which is why a revocation does not
    // wait on the inventory clock.
    expect(await members.profilesFor(ONE)).toEqual(['personal']);
  });

  test("a config that will not parse is that profile's problem alone", async () => {
    // The first version of this module threw out of the whole pass here, and an
    // automated review was right to call it a revocation bypass: one typo held
    // every *other* profile's reach at its last known value too, for as long as
    // the typo lasted. Dropping the one profile also matches what is actually
    // reachable — `openRuntime` cannot open a config that will not parse, so
    // `openReconciled` skips it and nothing is served under it anyway.
    let clock = 1_000;
    const stale: string[] = [];
    const root = await workspace([
      { name: 'personal', members: [ONE] },
      { name: 'work', members: [ONE, TWO] },
    ]);
    const members = workspaceMembers(root, { now: () => clock, onStale: (r) => stale.push(r) });

    expect([...(await members.profilesFor(ONE))].sort()).toEqual(['personal', 'work']);

    await writeFile(join(root, layout.profileConfig('work')), 'contract: [unclosed\n');
    clock += MEMBERS_TTL_MS;

    expect(await members.profilesFor(ONE)).toEqual(['personal']);
    expect(await members.profilesFor(TWO)).toEqual([]);
    expect(stale).toHaveLength(1);
  });

  test('a broken config does not hold up a revocation elsewhere', async () => {
    // The property the per-profile split exists for, stated on its own: a file
    // nobody can parse must not become a way to keep reach somewhere else.
    let clock = 1_000;
    const root = await workspace([
      { name: 'personal', members: [ONE] },
      { name: 'broken', members: [TWO] },
    ]);
    const members = workspaceMembers(root, { now: () => clock, onStale: () => {} });

    await members.profilesFor(ONE);

    await writeFile(join(root, layout.profileConfig('broken')), 'contract: [unclosed\n');
    await writeProfileFixture(root, 'personal', profileYaml('personal', { members: [] }));
    clock += MEMBERS_TTL_MS;

    expect(await members.profilesFor(ONE)).toEqual([]);
  });
});

/**
 * The other error class, which only a misbehaving store produces.
 *
 * A bucket 503, a throttle, an expired metadata-server token. These go through
 * an injected store because the filesystem adapter cannot produce one — its
 * `list` swallows `readdir` errors and reports nothing stored yet — so without
 * the seam the fail-closed paths could only be exercised against the one
 * adapter that never takes them.
 */
describe('a workspace that cannot be read', () => {
  async function store(
    profiles: readonly { name: string; members?: readonly string[] }[],
  ): Promise<{ files: BlobStore; fail: (why: string | null) => void }> {
    const base = createMemoryBlobStore();
    const put = (key: string, text: string) =>
      base.put(key, new TextEncoder().encode(text), { contentType: 'application/yaml' });

    await put(CONNECTIONS_FILE, connectionsYaml());
    for (const profile of profiles) {
      await put(
        layout.profileConfig(profile.name),
        profileYaml(profile.name, { members: profile.members ?? [] }),
      );
    }

    let why: string | null = null;
    const files: BlobStore = {
      ...base,
      async get(key) {
        if (why !== null) throw new Error(why);
        return base.get(key);
      },
      async list(prefix) {
        if (why !== null) throw new Error(why);
        return base.list(prefix);
      },
    };

    return {
      files,
      fail: (next) => {
        why = next;
      },
    };
  }

  test('serves the last good answer, and says so', async () => {
    let clock = 1_000;
    const stale: string[] = [];
    const { files, fail } = await store([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers('gs://your-bucket', {
      files,
      now: () => clock,
      onStale: (reason) => stale.push(reason),
    });

    expect(await members.profilesFor(ONE)).toEqual(['personal']);

    fail('503 from the bucket');
    clock += MEMBERS_TTL_MS;

    // Not knowing is answered with the last thing it did know. A blip must not
    // read as "nobody is a member", which under an issued token would 401 every
    // connected client at once — and their correct response to a 401 is to
    // re-authorise, so the reply to a struggling bucket would be a stampede.
    expect(await members.profilesFor(ONE)).toEqual(['personal']);
    expect(stale).toEqual(['503 from the bucket']);
  });

  test('does not advance the clock on a failed pass, so recovery is immediate', async () => {
    let clock = 1_000;
    const stale: string[] = [];
    const { files, fail } = await store([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers('gs://your-bucket', {
      files,
      now: () => clock,
      onStale: (reason) => stale.push(reason),
    });

    await members.profilesFor(ONE);
    const good = members.stamp();

    fail('throttled');
    clock += MEMBERS_TTL_MS;
    expect(await members.profilesFor(ONE)).toEqual(['personal']);
    expect(members.stamp()).toBe(good);

    // Recovered without waiting out another window: a failed pass that stamped
    // the clock would hold the stale answer long after the cause had gone.
    fail(null);
    expect(await members.profilesFor(ONE)).toEqual(['personal']);
    expect(stale).toHaveLength(1);
  });

  test('stops serving a stale answer past the ceiling', async () => {
    // Unbounded staleness is a revocation bypass however good the reason.
    // Credentials revoked for the bucket, or a bucket deleted, fails every pass
    // forever — and reach frozen forever is the bypass. Past the ceiling this
    // throws and the authenticators' existing catch fails closed, which is
    // visible and recoverable where twelve-hour-old permissions are neither.
    let clock = 1_000;
    const { files, fail } = await store([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers('gs://your-bucket', {
      files,
      now: () => clock,
      onStale: () => {},
    });

    expect(await members.profilesFor(ONE)).toEqual(['personal']);

    fail('the bucket is gone');
    clock += MEMBERS_TTL_MS;
    expect(await members.profilesFor(ONE)).toEqual(['personal']);

    clock += STALE_CEILING_MS;

    await expect(members.profilesFor(ONE)).rejects.toThrow('the bucket is gone');
  });

  test('with nothing known yet is thrown on, not answered', async () => {
    // Fail closed at boot. Answering "nobody is a member" would log everybody
    // out, which is the same event seen from the other side.
    const { files, fail } = await store([{ name: 'personal', members: [ONE] }]);
    fail('no credentials for the bucket');

    const members = workspaceMembers('gs://your-bucket', { files });

    await expect(members.profilesFor(ONE)).rejects.toThrow('no credentials');
    expect(members.stamp()).toBeNull();
  });
});

describe('two clocks, so revocation never waits on the expensive read', () => {
  test('a profile that appeared is not seen on the hot clock', async () => {
    // The asymmetry, asserted as behaviour rather than by counting calls: the
    // hot pass reads the configs it already knows about and performs no
    // listing, so it cannot discover a name. This is a *grant* arriving late,
    // which the rule allows — `profile add` publishes, and this is the floor
    // under a notify that did not land.
    let clock = 1_000;
    const root = await workspace([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers(root, { now: () => clock });

    expect(await members.profilesFor(TWO)).toEqual([]);

    await writeProfileFixture(root, 'late', profileYaml('late', { members: [TWO] }));
    clock += MEMBERS_TTL_MS;

    expect(await members.profilesFor(TWO)).toEqual([]);

    clock += INVENTORY_TTL_MS;

    expect(await members.profilesFor(TWO)).toEqual(['late']);
  });

  test('a removal does not wait for the inventory clock', async () => {
    // Stated as its own test because it is the invariant, not a side effect:
    // whatever the two windows are, removal must not be the slower direction.
    let clock = 1_000;
    const root = await workspace([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers(root, { now: () => clock });

    await members.profilesFor(ONE);
    await writeProfileFixture(root, 'personal', profileYaml('personal', { members: [] }));
    clock += MEMBERS_TTL_MS;

    expect(await members.profilesFor(ONE)).toEqual([]);
    expect(MEMBERS_TTL_MS).toBeLessThan(INVENTORY_TTL_MS);
  });
});

describe('the stamp', () => {
  test('moves when a profile config changes', async () => {
    let clock = 1_000;
    const root = await workspace([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers(root, { now: () => clock });

    await members.profilesFor(ONE);
    const before = members.stamp();
    expect(before).not.toBeNull();

    await writeProfileFixture(root, 'personal', profileYaml('personal', { members: [ONE, TWO] }));
    clock += MEMBERS_TTL_MS;
    await members.profilesFor(ONE);

    expect(members.stamp()).not.toBe(before);
  });

  test('moves when connections.yaml changes, which no profile key would catch', async () => {
    // The key the first draft of this design would have missed. `connect`,
    // `connection declare` and `disconnect` all write this file at the
    // workspace root, so a stamp built only from `profiles/` would have left
    // two whole rows of the table converging on nothing but a notify.
    let clock = 1_000;
    const root = await workspace([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers(root, { now: () => clock });

    await members.profilesFor(ONE);
    const before = members.stamp();

    await writeFile(
      join(root, 'connections.yaml'),
      connectionsYaml([{ id: 'gm1', provider: 'gmail', account: 'ada.lovelace@example.com' }]),
    );
    clock += MEMBERS_TTL_MS;
    await members.profilesFor(ONE);

    expect(members.stamp()).not.toBe(before);
  });

  test('holds still when nothing changed, so a reload is not provoked for nothing', async () => {
    // A stamp that moved on every pass would turn the convergence floor into a
    // reload every five seconds per instance — and a reload clears every
    // connection's token cache, so that is not a cheap mistake.
    let clock = 1_000;
    const root = await workspace([{ name: 'personal', members: [ONE] }]);
    const members = workspaceMembers(root, { now: () => clock });

    await members.profilesFor(ONE);
    const before = members.stamp();

    clock += MEMBERS_TTL_MS;
    await members.profilesFor(ONE);

    expect(members.stamp()).toBe(before);
  });

  test('is null before any pass has run', async () => {
    const root = await workspace([{ name: 'personal', members: [ONE] }]);

    expect(workspaceMembers(root).stamp()).toBeNull();
  });
});

describe('the cacheless form a command uses', () => {
  test('declaredMembers answers now, and remembers nothing', async () => {
    const root = await workspace([{ name: 'personal', members: [ONE] }]);

    expect(await declaredMembers(root, ONE)).toEqual(['personal']);

    await writeProfileFixture(root, 'personal', profileYaml('personal', { members: [] }));

    // No window to wait out: `token list` is a person at a terminal, and an
    // answer up to five seconds old would be a worse answer for no saving.
    expect(await declaredMembers(root, ONE)).toEqual([]);
  });
});
