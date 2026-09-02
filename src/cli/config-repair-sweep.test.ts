import { SUPPORTED_CONTRACT } from '#profile';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ensureRegistryContract, repairOwnerLayer } from './config-repair-sweep.ts';

/**
 * The sweep, against a real workspace on disk.
 *
 * `config-edit.test.ts` covers the decision — what one profile is missing — as
 * a pure function of two documents. This covers what only the sweep can get
 * wrong: the file it writes, whether a second run is silent, and what it says
 * when a profile will not open.
 */

const homes: string[] = [];

const REGISTRY = (contract: number): string =>
  `contract: ${contract}\nworkspaces:\n  local:\n    credentials: { adapter: file }\n` +
  '    storage: { adapter: filesystem }\n';

async function workspace(
  registry: string | null,
  profile: string | null = null,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-sweep-'));
  homes.push(root);

  if (registry !== null) await writeFile(join(root, 'workspaces.yaml'), registry);
  await writeFile(join(root, 'connections.yaml'), 'contract: 5\nconnections: []\noauth_apps: {}\n');

  if (profile !== null) {
    await mkdir(join(root, 'profiles', 'personal'), { recursive: true });
    await writeFile(join(root, 'profiles', 'personal', 'profile.yaml'), profile);
  }

  return root;
}

const registryOf = async (root: string): Promise<{ contract?: number }> =>
  parse(await readFile(join(root, 'workspaces.yaml'), 'utf8')) as { contract?: number };

afterAll(async () => {
  await Promise.all(homes.map((root) => rm(root, { recursive: true, force: true })));
});

describe('the registry contract stamp', () => {
  test('a registry left behind at 3 is brought to the current contract', async () => {
    // The state 0.9.0's migration produced: `renameRegistry` copies
    // `lanes-link.yaml` byte for byte, which is what makes an interruption
    // survivable, and carried the old `contract:` across with everything else.
    const root = await workspace(REGISTRY(3));

    expect(await ensureRegistryContract(root)).toBe(true);
    expect((await registryOf(root)).contract).toBe(SUPPORTED_CONTRACT);
  });

  test('a second run changes nothing and says nothing', async () => {
    const root = await workspace(REGISTRY(3));
    await ensureRegistryContract(root);

    expect(await ensureRegistryContract(root)).toBe(false);
  });

  test('a workspace with no registry is left alone rather than given one', async () => {
    // A `gs://` root mid-migration, or a directory that is not a workspace at
    // all. Writing a registry here would invent a workspace declaring nothing.
    const root = await workspace(null);

    expect(await ensureRegistryContract(root)).toBe(false);
  });

  test('the stamp is a one-field edit, not a rewrite', async () => {
    const root = await workspace(REGISTRY(3));

    await ensureRegistryContract(root);

    // Losing this file is losing the address of every target, so the edit has
    // to go through the document rather than regenerate it.
    const registry = (await registryOf(root)) as {
      workspaces?: Record<string, { storage?: { adapter?: string } }>;
    };
    expect(registry.workspaces?.['local']?.storage?.adapter).toBe('filesystem');
  });

  test('the sweep reports the stamp it applied', async () => {
    const root = await workspace(REGISTRY(3));
    const said: string[] = [];

    await repairOwnerLayer(root, undefined, { report: (line) => said.push(line) });

    expect(said.join('\n')).toContain('workspaces.yaml');
    expect(said.join('\n')).toContain(`contract ${SUPPORTED_CONTRACT}`);
  });
});

describe('what it says when a profile will not open', () => {
  test('the warning names the reason, not just the path', async () => {
    // It was `error.message.split('\n')[0]`, and a `ConfigError` from a schema
    // failure is `<path>:\n  <field>: <reason>` — so an upgrade printed "could
    // not give personal its owner layer: /…/personal.yaml:" and named no reason
    // at all. Seen for real, twice, with nothing after the colon.
    const root = await workspace(
      REGISTRY(SUPPORTED_CONTRACT),
      'contract: 5\ninstance:\n  profile: personal\ngrants:\n' +
        '  - { connection: 12345, allow: 7 }\nmembers: []\n',
    );
    const said: string[] = [];

    await repairOwnerLayer(root, undefined, { report: (line) => said.push(line) });

    const warning = said.find((line) => line.includes('could not give'));
    expect(warning).toBeDefined();
    expect(warning).toContain('connection');
    expect(warning?.trimEnd().endsWith(':')).toBe(false);
  });
});
