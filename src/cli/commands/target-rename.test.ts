import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceYaml } from '#profile/testing.ts';
import { renameTarget } from './target-rename.ts';

/**
 * Renaming a target, and the one name that may not move.
 *
 * `cloud` was never a name the code chose — it is the example in the docs, and
 * the flag somebody then types every day. A name that says what the thing *is*
 * is worth having, so this exists.
 *
 * `managed` is the exception, and the reason is not tidiness. The control
 * surface resolves that key by name out of the registry, so renaming it leaves
 * every control call failing while the CLI still looks perfectly healthy.
 */

const roots: string[] = [];

async function workspace(yaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-rename-'));
  roots.push(root);
  await writeFile(join(root, 'workspaces.yaml'), yaml);
  return root;
}

const registry = async (root: string): Promise<string> =>
  readFile(join(root, 'workspaces.yaml'), 'utf8');

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('renaming a target', () => {
  test('moves the key', async () => {
    const root = await workspace(workspaceYaml(['local', 'cloud']));

    await renameTarget('cloud', 'self-hosted-acme', { root });

    const text = await registry(root);
    expect(text).toContain('self-hosted-acme:');
    expect(text).not.toContain('\n  cloud:');
  });

  test('keeps the adapters the old name had', async () => {
    // The point is a label, not a migration: the bucket and the credentials
    // are the same ones, and a rename that quietly reset them would be a
    // different and much worse command.
    const root = await workspace(workspaceYaml(['local', 'cloud']));
    const before = await registry(root);

    await renameTarget('cloud', 'self-hosted-acme', { root });

    const after = await registry(root);
    for (const line of before.split('\n').filter((one) => one.startsWith('    '))) {
      expect(after).toContain(line);
    }
  });

  test('leaves the other targets alone', async () => {
    const root = await workspace(workspaceYaml(['local', 'cloud']));

    await renameTarget('cloud', 'self-hosted-acme', { root });

    expect(await registry(root)).toContain('local:');
  });

  test('answers what it did, for the caller that prints it', async () => {
    const root = await workspace(workspaceYaml(['local', 'cloud']));

    const renamed = await renameTarget('cloud', 'self-hosted-acme', { root });

    expect(renamed).toMatchObject({ from: 'cloud', to: 'self-hosted-acme' });
  });
});

describe('what it refuses', () => {
  test('a target this workspace does not declare', async () => {
    const root = await workspace(workspaceYaml(['local']));

    await expect(renameTarget('nope', 'other', { root })).rejects.toThrow(/no target called/i);
  });

  test('a name something else already has', async () => {
    // Refused rather than merged. Two targets are two adapter sets, and the one
    // that lost would take its bucket and its credentials with it.
    const root = await workspace(workspaceYaml(['local', 'cloud']));

    await expect(renameTarget('cloud', 'local', { root })).rejects.toThrow(/already declares/i);
  });

  test('a name that is not usable as one', async () => {
    const root = await workspace(workspaceYaml(['local', 'cloud']));

    await expect(renameTarget('cloud', 'two words', { root })).rejects.toThrow(/not a usable/i);
  });

  test('renaming something to what it already is', async () => {
    const root = await workspace(workspaceYaml(['local']));

    await expect(renameTarget('local', 'local', { root })).rejects.toThrow(/already its name/i);
  });
});

describe('managed, which is the workspace’s and not yours', () => {
  test('cannot be renamed', async () => {
    const root = await workspace(workspaceYaml(['local']));

    await expect(renameTarget('managed', 'mine', { root })).rejects.toThrow(/not a name you can/i);
  });

  test('cannot be renamed onto either', async () => {
    // The same collision by a different road: moving another target onto the
    // reserved key lands on top of the real one.
    const root = await workspace(workspaceYaml(['local']));

    await expect(renameTarget('local', 'managed', { root })).rejects.toThrow(/not a name you can/i);
  });

  test('is refused before the registry is even read', async () => {
    // No workspace at all, so if the guard ran later this would fail with
    // "no such config file" instead — and the person would go looking at the
    // wrong thing.
    await expect(renameTarget('managed', 'mine', { root: '/nonexistent' })).rejects.toThrow(
      /not a name you can/i,
    );
  });

  test('sends the person to the dashboard, not to a YAML file', async () => {
    // What somebody actually wants when they try this is to change the
    // workspace's *name*, which is a Lanes thing and not a target key.
    const root = await workspace(workspaceYaml(['local']));

    await expect(renameTarget('managed', 'mine', { root })).rejects.toThrow(/dashboard/i);
  });
});
