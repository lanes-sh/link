import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigDocument, newProfileTemplate } from './config-edit.ts';
import {
  ensureOwnerLayer,
  ensureReservedConnection,
  repairLines,
  type SurfaceRepair,
} from './config-repair.ts';

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
  await mkdir(join(root, 'profiles'), { recursive: true });
  const path = join(root, 'profiles', 'personal.yaml');
  await writeFile(path, contents ?? newProfileTemplate('personal', 7337));
  return { root, path };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('comments and ordering survive an edit', () => {
  test('block comments are preserved verbatim', async () => {
    const { root, path } = await profileFile();
    const before = await readFile(path, 'utf8');

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['oauth_apps', 'google'], { client_id_ref: 'google/id', client_secret_ref: 'google/secret' });
    await document.save();

    const after = await readFile(path, 'utf8');

    for (const comment of [
      '# Lanes Link profile: personal',
      '# This file says nothing about where it runs, and that is the point.',
      '# Only what is listed here is reachable, and an empty policy grants nothing.',
    ]) {
      expect(before).toContain(comment);
      expect(after).toContain(comment);
    }
  });

  test('an operator comment added by hand survives too', async () => {
    const { root, path } = await profileFile();
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('connections:', '# my note here\nconnections:'));

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['oauth_apps', 'google'], { client_id_ref: 'google/id', client_secret_ref: 'google/secret' });
    await document.save();

    expect(await readFile(path, 'utf8')).toContain('# my note here');
  });

  test('key ordering is unchanged', async () => {
    const { root, path } = await profileFile();
    const keysOf = (text: string) =>
      text.split('\n').filter((line) => /^[a-z_]+:/.test(line)).map((line) => line.split(':')[0]);

    const before = keysOf(await readFile(path, 'utf8'));

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['oauth_apps', 'google'], { client_id_ref: 'google/id', client_secret_ref: 'google/secret' });
    document.addTo(['connections'], { id: 'a', provider: 'example', account: 'a@example.com' });
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
    const { root, path } = await profileFile(`contract: 2

instance:
  profile: personal

oauth_apps: {}
connections: []
policy:
  allow: []
  deny: []
`);

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['oauth_apps', 'google'], { client_id_ref: 'google/id', client_secret_ref: 'google/secret' });
    document.addTo(['connections'], { id: 'a', provider: 'example', account: 'a@example.com' });
    document.addTo(['connections'], { id: 'b', provider: 'example', account: 'b@example.com' });
    document.addTo(
      ['policy', 'allow'],
      'example.*',
      { inline: true },
    );
    await document.save();

    const text = await readFile(path, 'utf8');

    // Connections carry enough fields to want a block; a policy rule is far
    // easier to scan one per line, which is how init.md writes them too.
    expect(text).toContain('connections:\n  - id: a');
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
    document.addTo(['policy', 'allow'], 'gmail.search');

    await expect(document.save()).rejects.toThrow(/has no connection/);
    // The file is untouched: a config left invalid by a failed command is
    // worse than a command that refuses to run.
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('a credential value cannot be introduced through the CLI', async () => {
    const { root, path } = await profileFile();
    const before = await readFile(path, 'utf8');

    const document = await ConfigDocument.open(root, 'personal');
    document.setIn(['oauth_apps', 'google'], {
      client_id_ref: 'google/client_id',
      client_secret: 'ya29.a0AfH6SMBnotreal',
    });

    await expect(document.save()).rejects.toThrow(/credential/i);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('leaves no temporary file behind on success or failure', async () => {
    const { root, path } = await profileFile();
    const directory = join(path, '..');

    const good = await ConfigDocument.open(root, 'personal');
    good.addTo(['connections'], { id: 'a', provider: 'example', account: 'a@example.com' });
    await good.save();

    const bad = await ConfigDocument.open(root, 'personal');
    bad.addTo(['policy', 'allow'], 'gmail.search');
    await bad.save().catch(() => {});

    expect((await readdir(directory)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

describe('idempotence', () => {
  test('re-applying the same edit produces an identical file', async () => {
    const { root, path } = await profileFile();

    const first = await ConfigDocument.open(root, 'personal');
    first.addTo(['connections'], { id: 'a', provider: 'example', account: 'a@example.com' });
    await first.save();
    const afterFirst = await readFile(path, 'utf8');

    const second = await ConfigDocument.open(root, 'personal');
    // The same edit `connect` would make on a re-run. It must not append a
    // second copy, or reconnecting a live account would grow the file forever
    // — which is exactly the bug that produced `main2` and `main3`.
    const existing = (second.getIn(['connections']) as { items?: unknown[] })?.items ?? [];
    if (existing.length === 0) {
      second.addTo(['connections'], { id: 'a', provider: 'example', account: 'a@example.com' });
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
   * `ensureOwnerLayer` runs this over six of them and accumulates; the rules
   * that are subtle — a deny that survives, an expiry that counts, a blanket
   * allow that already covers — are per surface, so they are checked here and
   * the layer's own behaviour is checked in the block below.
   */
  const ensureSetup = (document: ConfigDocument): SurfaceRepair =>
    ensureReservedConnection(document, 'setup');

  /** A profile as it was written before the surface, and as this operator's is. */
  const OLD = `contract: 2
instance:
  profile: personal
  port: 7337
connections:
  - id: ada_lovelace
    provider: gmail
    account: ada.lovelace@example.com
policy:
  allow:
    - gmail.*
  deny: []
`;

  test('adds both halves, because either alone is inert', async () => {
    const { root } = await profileFile(OLD);

    const document = await ConfigDocument.open(root, 'personal');
    const added = repairLines(ensureSetup(document));
    await document.save();

    expect(added).toEqual(['connections += setup.main', 'policy.allow += setup.*']);

    const config = document.toJSON() as {
      connections: { id: string; provider: string; account: string }[];
      policy: { allow: string[] };
    };
    expect(config.connections).toContainEqual({ id: 'main', provider: 'setup', account: 'Setup' });
    expect(config.policy.allow).toContain('setup.*');
  });

  test('the existing connection and grant are left alone', async () => {
    const { root } = await profileFile(OLD);

    const document = await ConfigDocument.open(root, 'personal');
    ensureSetup(document);

    const config = document.toJSON() as {
      connections: { id: string; provider: string; account: string }[];
      policy: { allow: string[] };
    };
    expect(config.connections).toContainEqual({
      id: 'ada_lovelace',
      provider: 'gmail',
      account: 'ada.lovelace@example.com',
    });
    expect(config.policy.allow).toContain('gmail.*');
  });

  test('a second run changes nothing', async () => {
    const { root, path } = await profileFile(OLD);

    const first = await ConfigDocument.open(root, 'personal');
    ensureSetup(first);
    await first.save();
    const afterFirst = await readFile(path, 'utf8');

    const second = await ConfigDocument.open(root, 'personal');
    expect(repairLines(ensureSetup(second))).toEqual([]);
    await second.save();

    expect(await readFile(path, 'utf8')).toBe(afterFirst);
  });

  test('a fresh profile from the template needs no repair at all', async () => {
    const { root } = await profileFile();

    const document = await ConfigDocument.open(root, 'personal');

    // The template already writes both. If this ever fails, the template and
    // its repair have drifted and one of them is writing a second spelling.
    expect(repairLines(ensureSetup(document))).toEqual([]);
  });

  test('the row alone is repaired when only the grant is there', async () => {
    const { root } = await profileFile(OLD.replace('    - gmail.*', '    - gmail.*\n    - setup.*'));

    const document = await ConfigDocument.open(root, 'personal');

    expect(repairLines(ensureSetup(document))).toEqual(['connections += setup.main']);
  });

  test('the grant alone is repaired when only the row is there', async () => {
    const { root } = await profileFile(
      OLD.replace(
        '    account: ada.lovelace@example.com',
        '    account: ada.lovelace@example.com\n  - { id: main, provider: setup, account: Setup }',
      ),
    );

    const document = await ConfigDocument.open(root, 'personal');

    expect(repairLines(ensureSetup(document))).toEqual(['policy.allow += setup.*']);
  });

  test('a blanket allow already covers it, so no rule is added', async () => {
    const { root } = await profileFile(OLD.replace('    - gmail.*', "    - '*'"));

    const document = await ConfigDocument.open(root, 'personal');

    expect(repairLines(ensureSetup(document))).toEqual(['connections += setup.main']);
  });

  test('a rule written with an expiry is recognised, not duplicated', async () => {
    // `policyRuleSchema` takes a bare pattern or `{ capability, expires_at }`.
    // Reading only the string form would re-add a rule the operator has.
    const { root } = await profileFile(
      OLD.replace('    - gmail.*', '    - gmail.*\n    - { capability: setup.*, expires_at: "2030-01-01T00:00:00Z" }'),
    );

    const document = await ConfigDocument.open(root, 'personal');

    expect(repairLines(ensureSetup(document))).toEqual(['connections += setup.main']);
  });

  /**
   * A lapsed rule is in force for nothing (`evaluate` holds one to
   * `expiresAt > now`), and reading the capability alone got both directions
   * wrong in the way that is hardest to see from the output.
   */
  describe('a rule that has expired is not a rule', () => {
    const LAPSED = '2020-01-01T00:00:00Z';

    test('a lapsed allow does not count as the grant', async () => {
      const { root } = await profileFile(
        OLD.replace('    - gmail.*', `    - gmail.*\n    - { capability: setup.*, expires_at: "${LAPSED}" }`),
      );

      const document = await ConfigDocument.open(root, 'personal');

      // Reading it as live wrote the row, skipped the rule, and reported "an
      // agent can now see what is connected here" — the inert half-state this
      // whole function exists to make impossible.
      expect(repairLines(ensureSetup(document))).toEqual([
        'connections += setup.main',
        'policy.allow += setup.*',
      ]);
    });

    test('a lapsed deny does not block the repair', async () => {
      const { root } = await profileFile(
        OLD.replace(
          '  deny: []',
          `  deny:\n    - { capability: setup.*, expires_at: "${LAPSED}" }`,
        ),
      );

      const document = await ConfigDocument.open(root, 'personal');

      // Reading it as live meant a deny that stopped denying years ago blocked
      // the repair for good — and printed nothing, because returning nothing to
      // add is exactly how "already had it" looks.
      expect(repairLines(ensureSetup(document))).toEqual([
        'connections += setup.main',
        'policy.allow += setup.*',
      ]);
    });

    test('a deny that has not expired still stops it', async () => {
      const { root } = await profileFile(
        OLD.replace(
          '  deny: []',
          '  deny:\n    - { capability: setup.*, expires_at: "2999-01-01T00:00:00Z" }',
        ),
      );

      const document = await ConfigDocument.open(root, 'personal');

      expect(repairLines(ensureSetup(document))).toEqual([]);
    });
  });

  test("the operator's comments survive the repair", async () => {
    const { root, path } = await profileFile(`# my own note about this profile\n${OLD}`);

    const document = await ConfigDocument.open(root, 'personal');
    ensureSetup(document);
    await document.save();

    expect(await readFile(path, 'utf8')).toContain('# my own note about this profile');
  });

  test('the repaired file is still valid config', async () => {
    const { root } = await profileFile(OLD);

    const document = await ConfigDocument.open(root, 'personal');
    ensureSetup(document);

    // `save` validates the rendered text before writing, so this throwing is
    // the assertion — a repair that produced an invalid file would leave the
    // profile unopenable.
    await document.save();
  });

  /**
   * Nothing here has been through a schema. `deploy` repairs sibling profiles
   * it never validated, so this reads whatever was typed — and a key written
   * with no value under it is a null scalar, not an absent one.
   */
  describe('a hand-edited file that no schema has seen', () => {
    test('a bare `connections:` key is written into, not crashed on', async () => {
      const { root } = await profileFile(
        OLD.replace(
          'connections:\n  - id: ada_lovelace\n    provider: gmail\n    account: ada.lovelace@example.com',
          'connections:',
        ),
      );

      const document = await ConfigDocument.open(root, 'personal');

      // Deleting the last entry by hand leaves exactly this. It used to reach
      // `null.add(...)` — a TypeError with a stack trace, mid-deploy, after the
      // provision steps had already created cloud resources.
      expect(repairLines(ensureSetup(document))).toEqual([
        'connections += setup.main',
        'policy.allow += setup.*',
      ]);

      const config = document.toJSON() as {
        connections: { id: string; provider: string; account: string }[];
      };
      expect(config.connections).toContainEqual({ id: 'main', provider: 'setup', account: 'Setup' });
    });

    test('a bare `allow:` key is written into too', async () => {
      const { root } = await profileFile(OLD.replace('    - gmail.*', ''));

      const document = await ConfigDocument.open(root, 'personal');

      expect(repairLines(ensureSetup(document))).toEqual([
        'connections += setup.main',
        'policy.allow += setup.*',
      ]);
    });

    test('a connections mapping is left alone rather than throwing', async () => {
      // Not a shape any schema accepts, so the row cannot be appended to it —
      // but `validateConfig` is what should say so, on the whole file, rather
      // than this dying on `.some`.
      const { root } = await profileFile(
        OLD.replace(
          'connections:\n  - id: ada_lovelace\n    provider: gmail\n    account: ada.lovelace@example.com',
          'connections:\n  a: { provider: gmail }',
        ),
      );

      const document = await ConfigDocument.open(root, 'personal');

      expect(() => ensureSetup(document)).not.toThrow();
    });
  });

  /**
   * Deleting the two lines no longer removes the surface — the next `connect`
   * or `deploy` puts them back. A deny is what makes it stay off, so it is the
   * one thing the repair must not undo.
   */
  describe('an operator who turned it off', () => {
    test('a deny covering the surface stops the repair entirely', async () => {
      const { root } = await profileFile(OLD.replace('  deny: []', '  deny:\n    - setup.*'));

      const document = await ConfigDocument.open(root, 'personal');

      // Not "added the rule but it is denied": a deny beats an allow, so the
      // caller would have printed that an agent can now see what is connected
      // here, about a surface that is still refused.
      expect(repairLines(ensureSetup(document))).toEqual([]);
    });

    test('a blanket deny stops it too', async () => {
      const { root } = await profileFile(OLD.replace('  deny: []', "  deny:\n    - '*'"));

      const document = await ConfigDocument.open(root, 'personal');

      expect(repairLines(ensureSetup(document))).toEqual([]);
    });

    test('denying one capability is a narrowing, and the repair still runs', async () => {
      // `setup.provider` withheld is the operator keeping the overview and
      // dropping the command detail — not switching the surface off. Refusing
      // to repair would leave them with neither.
      const { root } = await profileFile(OLD.replace('  deny: []', '  deny:\n    - setup.provider'));

      const document = await ConfigDocument.open(root, 'personal');

      expect(repairLines(ensureSetup(document))).toEqual([
        'connections += setup.main',
        'policy.allow += setup.*',
      ]);
    });
  });
});

/**
 * The owner layer as a whole — ADR-050.
 *
 * The per-surface rules are held above. What this block is for is the part that
 * only exists once there are six of them: that a profile written before they
 * were default gets all six on the next command, that each is still decided on
 * its own, and that the template needs no repair — because a template and its
 * repair writing two spellings of one row is the failure `config-repair.ts` is
 * shaped to prevent.
 */
describe('repairing a profile that predates the owner layer', () => {
  const OLD = `contract: 2
instance:
  profile: personal
connections:
  - id: ada_lovelace
    provider: gmail
    account: ada.lovelace@example.com
policy:
  allow:
    - gmail.*
  deny: []
`;

  test('all seven arrive, both halves each, in the order the template writes', async () => {
    const { root } = await profileFile(OLD);

    const document = await ConfigDocument.open(root, 'personal');
    const added = repairLines(ensureOwnerLayer(document));
    await document.save();

    expect(added).toEqual([
      'connections += memory.main',
      'connections += tasks.main',
      'connections += assets.main',
      'connections += skills.main',
      'connections += vault.main',
      'connections += setup.main',
      'connections += entities.main',
      'policy.allow += memory.*',
      'policy.allow += tasks.*',
      'policy.allow += assets.*',
      'policy.allow += skills.*',
      'policy.allow += vault.*',
      'policy.allow += setup.*',
      'policy.allow += entities.*',
    ]);
  });

  test('identity is not among them, because a profile declaring none has nothing to report', async () => {
    const { root } = await profileFile(OLD);

    const document = await ConfigDocument.open(root, 'personal');
    ensureOwnerLayer(document);

    const config = document.toJSON() as {
      connections: { provider: string }[];
      policy: { allow: string[] };
    };
    expect(config.connections.map((row) => row.provider)).not.toContain('identity');
    expect(config.policy.allow).not.toContain('identity.*');
  });

  test('the account already there is untouched', async () => {
    const { root } = await profileFile(OLD);

    const document = await ConfigDocument.open(root, 'personal');
    ensureOwnerLayer(document);

    const config = document.toJSON() as {
      connections: { id: string; provider: string; account: string }[];
      policy: { allow: string[] };
    };
    expect(config.connections).toContainEqual({
      id: 'ada_lovelace',
      provider: 'gmail',
      account: 'ada.lovelace@example.com',
    });
    expect(config.policy.allow).toContain('gmail.*');
  });

  test('a fresh profile from the template needs no repair at all', async () => {
    const { root } = await profileFile();

    const document = await ConfigDocument.open(root, 'personal');

    // If this fails, the template and its repair have drifted and one of them is
    // writing a second spelling of a row the other already wrote.
    expect(repairLines(ensureOwnerLayer(document))).toEqual([]);
  });

  test('a second run changes nothing', async () => {
    const { root, path } = await profileFile(OLD);

    const first = await ConfigDocument.open(root, 'personal');
    ensureOwnerLayer(first);
    await first.save();
    const afterFirst = await readFile(path, 'utf8');

    const second = await ConfigDocument.open(root, 'personal');
    expect(repairLines(ensureOwnerLayer(second))).toEqual([]);
    await second.save();

    expect(await readFile(path, 'utf8')).toBe(afterFirst);
  });

  test('one surface denied stays denied while the rest are repaired', async () => {
    // The operator who does not want an agent writing skills. Repairing that one
    // would undo a decision; refusing to repair the others would punish them for
    // having made it.
    const { root } = await profileFile(OLD.replace('  deny: []', '  deny:\n    - skills.*'));

    const document = await ConfigDocument.open(root, 'personal');
    const added = repairLines(ensureOwnerLayer(document));

    expect(added).not.toContain('connections += skills.main');
    expect(added).not.toContain('policy.allow += skills.*');
    expect(added).toContain('connections += memory.main');
    expect(added).toContain('policy.allow += tasks.*');
  });

  test('a blanket deny leaves the whole layer off', async () => {
    const { root } = await profileFile(OLD.replace('  deny: []', "  deny:\n    - '*'"));

    const document = await ConfigDocument.open(root, 'personal');

    expect(repairLines(ensureOwnerLayer(document))).toEqual([]);
  });

  test('a blanket allow needs no rules, only rows', async () => {
    const { root } = await profileFile(OLD.replace('    - gmail.*', "    - '*'"));

    const document = await ConfigDocument.open(root, 'personal');
    const added = repairLines(ensureOwnerLayer(document));

    expect(added.filter((line) => line.startsWith('policy.allow'))).toEqual([]);
    expect(added).toHaveLength(7);
  });
});
