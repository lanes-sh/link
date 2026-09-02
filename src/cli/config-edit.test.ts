import { newConnectionsTemplate, newProfileTemplate } from './config-templates.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigDocument } from './config-edit.ts';
import { CONNECTIONS_FILE } from '#profile';
import { DEFAULT_SURFACES, ensureOwnerLayer, ensureReservedConnection, repairLines, type SurfaceRepair } from './config-repair.ts';
import { repairOwnerLayer } from './config-repair-sweep.ts';

/**
 * The config file is the source of truth, and an operator is meant to be able
 * to hand-edit it. A CLI that reformats or strips comments makes the file
 * hostile to editing, which then makes the CLI mandatory — so these
 * properties are load-bearing, not cosmetic.
 */

const roots: string[] = [];

/**
 * A workspace holding one profile, and the path its config landed on.
 *
 * `ConfigDocument` takes a workspace root and a profile name rather than a
 * path, because a workspace may be a bucket and the two stopped being the same
 * string. The tests still assert against the file, which is what makes them
 * worth having: comment preservation is only observable on disk.
 */
async function profileFile(contents?: string): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-edit-'));
  roots.push(root);
  await mkdir(join(root, 'profiles', 'personal'), { recursive: true });
  const path = join(root, 'profiles', 'personal', 'profile.yaml');
  await writeFile(path, contents ?? newProfileTemplate('personal', 7337));
  return { root, path };
}

/**
 * The two documents a repair now touches.
 *
 * The owner layer is a connection in the workspace and a grant in the profile
 * (ADR-057, ADR-059), so `ensureReservedConnection` writes into both or
 * neither. Handing tests a pair keeps that pairing in one place rather than in
 * thirty setups that could drift apart.
 */
interface Pair {
  readonly root: string;
  readonly path: string;
  readonly connections: ConfigDocument;
  readonly profile: ConfigDocument;
}

/** Re-open both documents of a workspace that has already been written. */
async function pair2(root: string): Promise<Pair> {
  return {
    root,
    path: join(root, 'profiles', 'personal', 'profile.yaml'),
    connections: await ConfigDocument.openKey(root, CONNECTIONS_FILE),
    profile: await ConfigDocument.open(root, 'personal'),
  };
}

async function pair(contents?: string, connections?: string): Promise<Pair> {
  const { root, path } = await profileFile(contents);
  await writeFile(join(root, CONNECTIONS_FILE), connections ?? newConnectionsTemplate());

  return {
    root,
    path,
    connections: await ConfigDocument.openKey(root, CONNECTIONS_FILE),
    profile: await ConfigDocument.open(root, 'personal'),
  };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('comments and ordering survive an edit', () => {
  test('block comments are preserved verbatim', async () => {
    const { root, path } = await profileFile();
    const before = await readFile(path, 'utf8');

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['limits', 'requests_per_minute'], 240);
    await document.save();

    const after = await readFile(path, 'utf8');

    for (const comment of [
      '# Lanes Link profile: personal',
      '# This file says nothing about where it runs, and that is the point.',
      '# One row per connection this profile may reach, and what it may do with each.',
    ]) {
      expect(before).toContain(comment);
      expect(after).toContain(comment);
    }
  });

  test('an operator comment added by hand survives too', async () => {
    const { root, path } = await profileFile();
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('grants:', '# my note here\ngrants:'));

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['limits', 'requests_per_minute'], 240);
    await document.save();

    expect(await readFile(path, 'utf8')).toContain('# my note here');
  });

  test('key ordering is unchanged', async () => {
    const { root, path } = await profileFile();
    const keysOf = (text: string) =>
      text.split('\n').filter((line) => /^[a-z_]+:/.test(line)).map((line) => line.split(':')[0]);

    const before = keysOf(await readFile(path, 'utf8'));

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['limits', 'requests_per_minute'], 240);
    document.addTo(['grants'], { connection: 'example.a', allow: ['example.*'], deny: [] });
    await document.save();

    expect(keysOf(await readFile(path, 'utf8'))).toEqual(before);
  });

  test('a grown collection becomes block style rather than one long line', async () => {
    // An empty collection written explicitly rather than taken from the
    // template: the property under test is what happens to `[]` when it grows,
    // and the template no longer ships one — it declares the `setup` connection
    // and its allow rule. Reading the starting state from the template would
    // leave this asserting nothing the day that changed, which is the day it
    // most needs to hold.
    const { root, path } = await profileFile(`contract: 4

instance:
  profile: personal

oauth_apps: {}
grants: []
members: []
`);

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['limits', 'requests_per_minute'], 240);
    document.addTo(['grants'], { connection: 'example.a', allow: ['example.*'], deny: [] });
    document.addTo(['grants'], { connection: 'example.b', allow: ['example.*'], deny: [] });
    document.addTo(
      ['grants', 0, 'allow'],
      'example.*',
      { inline: true },
    );
    await document.save();

    const text = await readFile(path, 'utf8');

    // A grant carries enough fields to want a block; a rule inside it is far
    // easier to scan one per line, which is how init.md writes them too.
    expect(text).toContain('grants:\n  - connection: example.a');
    expect(text).toMatch(/allow:\n\s+- example\.\*/);
    expect(text.split('\n').every((line) => line.length < 120)).toBe(true);
  });
});

describe('nested writes', () => {
  test('a key can be added inside a map written by an earlier setIn', async () => {
    // `connect` writes oauth_apps.<app> and may then write into it. If the
    // first stored a plain JS object rather than a YAML node, the second fails
    // with "Expected YAML collection" — which is exactly what happened the
    // first time anyone connected Gmail.
    const { root, path } = await profileFile();
    const document = await ConfigDocument.open(root, 'personal');

    document.setIn(['oauth_apps', 'google'], { client_id_ref: 'google/client_id' });
    document.setIn(['oauth_apps', 'google', 'client_secret_ref'], 'google/client_secret');

    const rendered = document.toString();
    expect(rendered).toContain('client_id_ref: google/client_id');
    expect(rendered).toContain('client_secret_ref: google/client_secret');
  });
});

describe('validation runs before the write', () => {
  test('a rule naming an unknown connection is refused', async () => {
    const { root, path } = await profileFile();
    const before = await readFile(path, 'utf8');

    const document = await ConfigDocument.open(root, 'personal');
    document.addTo(['grants', 0, 'allow'], 'gmail.search');

    await expect(document.save()).rejects.toThrow(/names provider "gmail"/);
    // The file is untouched: a config left invalid by a failed command is
    // worse than a command that refuses to run.
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('a credential value cannot be introduced through the CLI', async () => {
    const { root, path } = await profileFile();
    const before = await readFile(path, 'utf8');

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['auth', 'token_ref'], 'ya29.a0AfH6SMBnotreal');

    await expect(document.save()).rejects.toThrow(/credential/i);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('leaves no temporary file behind on success or failure', async () => {
    const { root, path } = await profileFile();
    const directory = join(path, '..');

    const good = await ConfigDocument.open(root, 'personal');
    good.addTo(['grants'], { connection: 'example.a', allow: ['example.*'], deny: [] });
    await good.save();

    const bad = await ConfigDocument.open(root, 'personal');
    bad.addTo(['grants', 0, 'allow'], 'gmail.search');
    await bad.save().catch(() => {});

    expect((await readdir(directory)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

describe('idempotence', () => {
  test('re-applying the same edit produces an identical file', async () => {
    const { root, path } = await profileFile();

    const first = await ConfigDocument.open(root, 'personal');
    first.addTo(['grants'], { connection: 'example.a', allow: ['example.*'], deny: [] });
    await first.save();
    const afterFirst = await readFile(path, 'utf8');

    const second = await ConfigDocument.open(root, 'personal');
    // The same edit `connect` would make on a re-run. It must not append a
    // second copy, or reconnecting a live account would grow the file forever
    // — which is exactly the bug that produced `main2` and `main3`.
    const existing = (second.getIn(['grants']) as { items?: unknown[] })?.items ?? [];
    if (existing.length === 0) {
      second.addTo(['grants'], { connection: 'example.a', allow: ['example.*'], deny: [] });
    }
    await second.save();

    expect(await readFile(path, 'utf8')).toBe(afterFirst);
  });
});

/**
 * A profile written before the setup surface existed has neither the connection
 * row nor the allow rule, and nothing at runtime says so: `allowedConnections`
 * returns nothing for a provider with no row *before* consulting policy, so the
 * tools are absent from `tools/list` rather than refused. That is the shape of
 * the bug this repairs, so the half-repaired states matter as much as the
 * missing one — either half alone is inert.
 */
describe('repairing a profile that predates the setup surface', () => {
  /**
   * One surface at a time, which is what these tests are about.
   *
   * `ensureOwnerLayer` runs this over seven of them and accumulates; the rules
   * that are subtle — a deny that survives, an expiry that counts, a blanket
   * allow that already covers — are per surface, so they are checked here and
   * the layer's own behaviour is checked in the block below.
   *
   * It touches two documents now. The connection belongs to the workspace and
   * the grant to the profile (ADR-057), and a repair that wrote one without the
   * other would leave a workspace that does not load.
   */
  const ensureSetup = (p: Pair): SurfaceRepair =>
    ensureReservedConnection(p.connections, p.profile, 'setup');

  /** A profile as it was written before the surface, and as this operator's is. */
  const OLD = `contract: 4
instance:
  profile: personal
  port: 7337
grants:
  - { connection: gmail.ada_lovelace, allow: [gmail.*], deny: [] }
members: []
`;

  /** The workspace it lives in, with no owner-layer row in it. */
  const OLD_CONNECTIONS = `contract: 4
connections:
  - { id: ada_lovelace, provider: gmail, account: ada.lovelace@example.com }
oauth_apps: {}
`;

  const rowsOf = (p: Pair) =>
    (p.connections.toJSON() as { connections: { id: string; provider: string; account: string }[] })
      .connections;

  const grantsOf = (p: Pair) =>
    (p.profile.toJSON() as {
      grants: { connection: string; allow: unknown[]; deny: unknown[] }[];
    }).grants;

  test('adds both halves, because either alone is inert', async () => {
    const p = await pair(OLD, OLD_CONNECTIONS);
    const added = repairLines(ensureSetup(p));

    // `lan1`, not `main`: an id is opaque and allocated now, and this
    // workspace's only other row is a vendor account, so the first owner-layer
    // number is free. The prefix is what says the surface is built in.
    expect(added).toEqual([
      'connections.yaml += setup.lan1',
      'grants += setup.lan1',
      'grants[].allow += setup.*',
    ]);

    expect(rowsOf(p)).toContainEqual({ id: 'lan1', provider: 'setup', account: 'Setup' });
    expect(grantsOf(p)).toContainEqual({ connection: 'setup.lan1', allow: ['setup.*'], deny: [] });
  });

  test("the operator's own connection and grant are left alone", async () => {
    const p = await pair(OLD, OLD_CONNECTIONS);
    ensureSetup(p);

    expect(rowsOf(p)).toContainEqual({
      id: 'ada_lovelace',
      provider: 'gmail',
      account: 'ada.lovelace@example.com',
    });
    expect(grantsOf(p)).toContainEqual({
      connection: 'gmail.ada_lovelace',
      allow: ['gmail.*'],
      deny: [],
    });
  });

  test('a second run changes nothing', async () => {
    const p = await pair(OLD, OLD_CONNECTIONS);
    ensureSetup(p);
    await p.profile.save();
    await p.connections.save();

    const again = await pair2(p.root);
    expect(repairLines(ensureSetup(again))).toEqual([]);
  });

  test('the row alone is repaired when the grant is already there', async () => {
    const p = await pair(
      OLD.replace('members: []', '  - { connection: setup.main, allow: [setup.*], deny: [] }\nmembers: []'),
      OLD_CONNECTIONS,
    );

    expect(repairLines(ensureSetup(p))).toEqual(['connections.yaml += setup.main']);
  });

  test('the grant alone is repaired when the row is already there', async () => {
    const p = await pair(
      OLD,
      OLD_CONNECTIONS.replace('oauth_apps: {}', '  - { id: main, provider: setup, account: Setup }\noauth_apps: {}'),
    );

    expect(repairLines(ensureSetup(p))).toEqual(['grants += setup.main', 'grants[].allow += setup.*']);
  });

  test('an operator who renamed the row keeps their id', async () => {
    // Any instance will do, and the first is taken rather than `main`
    // specifically — bolting a second `setup.main` on beside a renamed one
    // would be the repair inventing a surface the operator already has.
    const p = await pair(
      OLD,
      OLD_CONNECTIONS.replace('oauth_apps: {}', '  - { id: mine, provider: setup, account: Setup }\noauth_apps: {}'),
    );

    expect(repairLines(ensureSetup(p))).toEqual(['grants += setup.mine', 'grants[].allow += setup.*']);
  });

  describe('a rule that has expired is not a rule', () => {
    test('a rule written with an expiry is recognised, not duplicated', async () => {
      // `policyRuleSchema` takes a bare pattern or `{ capability, expires_at }`.
      // Reading only the string form would re-add a rule the operator has.
      const p = await pair(
        OLD.replace(
          'members: []',
          '  - { connection: setup.main, allow: [{ capability: setup.*, expires_at: "2030-01-01T00:00:00Z" }], deny: [] }\nmembers: []',
        ),
        OLD_CONNECTIONS,
      );

      expect(repairLines(ensureSetup(p))).toEqual(['connections.yaml += setup.main']);
    });
  });

  describe('a hand-edited file that no schema has seen', () => {
    test('a missing grants block is created rather than crashed on', async () => {
      const p = await pair(`contract: 4\ninstance:\n  profile: personal\n`, OLD_CONNECTIONS);

      expect(repairLines(ensureSetup(p))).toEqual([
        'connections.yaml += setup.lan1',
        'grants += setup.lan1',
        'grants[].allow += setup.*',
      ]);
    });

    test('a grants mapping is left alone rather than throwing', async () => {
      // Not a shape any schema accepts, so the row cannot be appended to it —
      // but `validateConfig` is what should say so, on the whole file, rather
      // than this dying on `.some`.
      const p = await pair(
        `contract: 4\ninstance:\n  profile: personal\ngrants:\n  a: { connection: gmail.x }\n`,
        OLD_CONNECTIONS,
      );

      expect(() => ensureSetup(p)).not.toThrow();
    });
  });

  describe('an operator who turned it off', () => {
    test('a deny covering the surface stops the repair entirely', async () => {
      // Deleting the row no longer removes the surface, because the next
      // command puts it back. A deny is the way it stays off, so it is the one
      // thing the repair must not undo (ADR-050).
      const p = await pair(
        OLD.replace('members: []', '  - { connection: setup.main, allow: [], deny: [setup.*] }\nmembers: []'),
        OLD_CONNECTIONS,
      );

      expect(repairLines(ensureSetup(p))).toEqual([]);
    });

    test('denying one capability is a narrowing, and the repair still runs', async () => {
      // `setup.provider` withheld is the operator keeping the overview and
      // dropping the command detail — not switching the surface off. Refusing
      // to repair would leave them with neither.
      const p = await pair(
        OLD.replace('members: []', '  - { connection: setup.main, allow: [], deny: [setup.provider] }\nmembers: []'),
        OLD_CONNECTIONS,
      );

      expect(repairLines(ensureSetup(p))).toEqual([
        'connections.yaml += setup.main',
        'grants[].allow += setup.*',
      ]);
    });
  });
});

/**
 * The owner layer as a whole — ADR-050, as amended by ADR-059.
 *
 * The per-surface rules are held above. What this block is for is the part that
 * only exists once there are seven of them: that a profile written before they
 * were default gets all seven on the next command, that each is still decided on
 * its own, and that the template needs no repair — because a template and its
 * repair writing two spellings of one row is the failure `config-repair.ts` is
 * shaped to prevent.
 */
describe('repairing a profile that predates the owner layer', () => {
  const OLD = `contract: 4
instance:
  profile: personal
  port: 7337
grants:
  - { connection: gmail.ada_lovelace, allow: [gmail.*], deny: [] }
members: []
`;

  const OLD_CONNECTIONS = `contract: 4
connections:
  - { id: ada_lovelace, provider: gmail, account: ada.lovelace@example.com }
oauth_apps: {}
`;

  test('every default surface arrives, and identity does not', async () => {
    const p = await pair(OLD, OLD_CONNECTIONS);
    const repair = ensureOwnerLayer(p.connections, p.profile);

    for (const provider of DEFAULT_SURFACES) {
      expect(repair.granted).toContain(`${provider}.*`);
    }

    // ADR-042: a profile declaring no identity has nothing for the surface to
    // report, so it arrives with the first `identity add` rather than here.
    expect(repair.granted).not.toContain('identity.*');
  });

  test('a surface the operator denied is left off', async () => {
    const p = await pair(
      OLD.replace('members: []', '  - { connection: skills.main, allow: [], deny: [skills.*] }\nmembers: []'),
      OLD_CONNECTIONS,
    );
    const repair = ensureOwnerLayer(p.connections, p.profile);

    expect(repair.granted).not.toContain('skills.*');
    expect(repair.granted).toContain('memory.*');
  });

  test('a fresh profile and workspace need no repair at all', async () => {
    // The check that keeps the template and the repair in one spelling. Two
    // spellings of one row is how they drift apart, and this is what notices.
    const p = await pair(newProfileTemplate('personal', 7337), newConnectionsTemplate());

    expect(repairLines(ensureOwnerLayer(p.connections, p.profile))).toEqual([]);
  });

  test('a second run changes nothing', async () => {
    const p = await pair(OLD, OLD_CONNECTIONS);
    ensureOwnerLayer(p.connections, p.profile);
    await p.profile.save();
    await p.connections.save();

    const again = await pair2(p.root);
    expect(repairLines(ensureOwnerLayer(again.connections, again.profile))).toEqual([]);
  });
});

describe('appending to a key that is not there yet', () => {
  test('a second append lands, and the sequence is written as a block', () => {
    // `addTo` used to create the sequence by setting a plain JS array. That is
    // not a collection the document API will traverse — the hazard `setIn`
    // documents one method above — so the *first* append landed and the second
    // found a value with no `.add` and threw `existing.add is not a function`.
    // `#expand` reads `.items` and was silently a no-op for the same reason,
    // leaving the sequence in flow style.
    //
    // Latent for as long as every path this is called with already existed.
    // `grants:` is genuinely absent on a contract-2 profile being repaired,
    // which is what finally made the second append reachable — and what turned
    // one upgrade into three warnings and an unrepaired workspace.
    const document = ConfigDocument.fromText('contract: 4\n');

    document.addTo(['grants'], { connection: 'example.a', allow: ['example.*'], deny: [] });
    document.addTo(['grants'], { connection: 'example.b', allow: ['example.*'], deny: [] });

    const rows = (document.getIn(['grants']) as { items?: unknown[] })?.items ?? [];
    expect(rows).toHaveLength(2);
    expect(document.toString()).toContain('grants:\n  - connection: example.a');
    expect(document.toString()).toContain('  - connection: example.b');
  });

  test('the whole owner layer is granted to a profile with no grants block', () => {
    // The path that actually broke: seven surfaces, appended one at a time, to
    // a profile that has never had a `grants:` key. The first surface used to
    // succeed and the second threw, so the profile was left with one grant of
    // seven and the command reported a warning instead of a repair.
    const connections = ConfigDocument.fromText(newConnectionsTemplate(), CONNECTIONS_FILE);
    const profile = ConfigDocument.fromText('contract: 4\n');

    const repair = ensureOwnerLayer(connections, profile);

    const rows = (profile.getIn(['grants']) as { items?: unknown[] })?.items ?? [];
    expect(rows).toHaveLength(DEFAULT_SURFACES.length);
    for (const surface of DEFAULT_SURFACES) {
      expect(repair.granted).toContain(`${surface}.*`);
    }
  });
});

describe('the repair reads this profile\'s grants, not the workspace\'s first row', () => {
  const workspaceRows = [
    'contract: 4',
    'connections:',
    '  - { id: main, provider: memory, account: Memory }',
    '  - { id: demo, provider: memory, account: Memory }',
    '  - { id: main, provider: vault, account: Vault }',
    '  - { id: demo, provider: vault, account: Vault }',
    '',
  ].join('\n');

  test('a profile that already has its own instance is left alone', () => {
    // Contract 3 puts every profile's owner layer in one file, so "the first
    // row for this provider" is whichever profile sorts first. The repair asked
    // whether this profile granted *that* row, saw that it did not, and set
    // about adding it — which for vault and skills the schema refuses, and for
    // memory, tasks, assets, setup and entities it does not: the profile would
    // have been handed another profile's notes and task list, which is the one
    // outcome ADR-059 exists to prevent.
    const connections = ConfigDocument.fromText(workspaceRows, CONNECTIONS_FILE);
    const profile = ConfigDocument.fromText(
      [
        'contract: 4',
        'grants:',
        '  - { connection: memory.demo, allow: [memory.*], deny: [] }',
        '  - { connection: vault.demo, allow: [vault.*], deny: [] }',
        '',
      ].join('\n'),
    );

    const repair = ensureReservedConnection(connections, profile, 'memory');

    expect(repair.changes).toEqual([]);
    expect(repair.granted).toEqual([]);
  });

  test('a surface the profile grants nothing for is still repaired', () => {
    // The case this was written for: a surface that did not exist when the
    // profile was written. Nothing about the fix above may turn that into a
    // no-op, or a release adding a surface would never reach an existing
    // profile.
    const connections = ConfigDocument.fromText(workspaceRows, CONNECTIONS_FILE);
    const profile = ConfigDocument.fromText('contract: 4\ngrants: []\n');

    const repair = ensureReservedConnection(connections, profile, 'memory');

    expect(repair.granted).toEqual(['memory.*']);
  });

  test('a deny on the profile\'s own instance still blocks the repair', () => {
    // A deny beats an allow, so writing the rule would widen nothing while
    // announcing that an agent can now read the surface. Read off the wrong row
    // this was invisible, and the repair undid a deliberate switch-off.
    const connections = ConfigDocument.fromText(workspaceRows, CONNECTIONS_FILE);
    const profile = ConfigDocument.fromText(
      [
        'contract: 4',
        'grants:',
        '  - { connection: memory.demo, allow: [], deny: [memory.*] }',
        '',
      ].join('\n'),
    );

    expect(ensureReservedConnection(connections, profile, 'memory')).toEqual({
      changes: [],
      granted: [],
    });
  });
});

describe('a profile granting two instances of one surface', () => {
  const twoInstances = [
    'contract: 4',
    'connections:',
    '  - { id: team, provider: memory, account: Memory }',
    '  - { id: personal, provider: memory, account: Memory }',
    '',
  ].join('\n');

  test('a deny on either of them switches the surface off', () => {
    // Reading only the first matching row let a deny be stepped around: the
    // repair widened the other instance and reported the surface granted, which
    // is the one thing `ensureReservedConnection` says it must never do.
    const connections = ConfigDocument.fromText(twoInstances, CONNECTIONS_FILE);
    const profile = ConfigDocument.fromText(
      [
        'contract: 4',
        'grants:',
        '  - { connection: memory.team, allow: [], deny: [] }',
        '  - { connection: memory.personal, allow: [], deny: [memory.*] }',
        '',
      ].join('\n'),
    );

    expect(ensureReservedConnection(connections, profile, 'memory')).toEqual({
      changes: [],
      granted: [],
    });
  });

  test('a grant on either of them counts as having the surface', () => {
    const connections = ConfigDocument.fromText(twoInstances, CONNECTIONS_FILE);
    const profile = ConfigDocument.fromText(
      [
        'contract: 4',
        'grants:',
        '  - { connection: memory.team, allow: [], deny: [] }',
        '  - { connection: memory.personal, allow: [memory.*], deny: [] }',
        '',
      ].join('\n'),
    );

    expect(ensureReservedConnection(connections, profile, 'memory').granted).toEqual([]);
  });

  test('a connection value with no dot in it matches no provider', () => {
    // These rows are raw unvalidated YAML. Slicing at the dot answered -1 for a
    // dotless value, and `'vaults'.slice(0, -1)` is `'vault'` — so a typo was
    // widened while the real surface stayed unreachable.
    const connections = ConfigDocument.fromText(
      'contract: 4\nconnections:\n  - { id: main, provider: vault, account: Vault }\n',
      CONNECTIONS_FILE,
    );
    const profile = ConfigDocument.fromText(
      'contract: 4\ngrants:\n  - { connection: vaults, allow: [], deny: [] }\n',
    );

    const repair = ensureReservedConnection(connections, profile, 'vault');
    expect(repair.changes).toEqual(['grants += vault.main']);
  });
});
