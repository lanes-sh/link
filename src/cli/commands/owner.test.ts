import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '#profile';
import { assetStorage, memoryStorage, taskStorage } from '#providers/owner.ts';
import { openRuntime, ownerPrincipal } from '../runtime.ts';
import { memoryStore, ownerConnection } from './owner.ts';
import { tasksStore } from './owner/tasks.ts';
import { assetsStore } from './owner/assets.ts';

/**
 * `lanes link memory` / `tasks` / `assets` / `skills` / `vault`.
 *
 * The property worth a test is not the printing — it is that these commands and
 * the providers address the **same bytes**. A control plane that writes its own
 * spelling of a storage layout works exactly until the day the two disagree,
 * and then fails in the way that is hardest to see: everything succeeds, and
 * the agent reads nothing.
 *
 * So the tests below write through the CLI's path and read back through a real
 * dispatch, and vice versa.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

const PROFILE = `contract: 1

instance:
  profile: personal
  default_target: local

targets:
  local:
    credentials: { adapter: file,       path: ./data/personal.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/files }

# Labelled the way the CLI writes them: the provider's own name. A tasks row
# under any other label is refused, because that is the only signal a config
# carries that it used to be Google Tasks (ADR-051). The ids stay "owner",
# since what these tests are about is that --connection resolves.
connections:
  - { id: owner, provider: memory, account: Memory }
  - { id: owner, provider: tasks,  account: Tasks }
  - { id: owner, provider: assets, account: Assets }
  - { id: owner, provider: skills, account: Skills }
  - { id: owner, provider: vault,  account: Vault }

policy:
  allow: ['*']
`;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-owner-cli-'));
  roots.push(root);

  await mkdir(join(root, 'profiles'), { recursive: true });
  await writeFile(join(root, 'lanes-link.yaml'), 'contract: 1\ndefault_profile: personal\n');
  await writeFile(join(root, 'profiles', 'personal.yaml'), PROFILE);

  process.env['LANES_LINK_HOME'] = root;
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('the CLI and the provider address the same bytes', () => {
  test('an entry written the CLI way is what memory.get returns', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      const store = memoryStore(runtime, {});
      await store.put(
        memoryStorage.key('deploy-window'),
        new TextEncoder().encode(
          memoryStorage.serialise({
            title: 'Deploy window',
            tags: ['ops'],
            updatedAt: new Date(0).toISOString(),
            body: 'Thursday evening.',
          }),
        ),
      );

      // Through the dispatcher, so this is the same path an agent takes:
      // policy evaluated, context built by core, namespace scoped by core.
      const outcome = await runtime.dispatcher.invoke({
        principal: ownerPrincipal('personal'),
        capabilityId: 'memory.get',
        connectionKey: 'memory.owner',
        arguments: { id: 'deploy-window' },
      });

      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome)).toContain('Thursday evening.');
    } finally {
      await runtime.close();
    }
  });

  test('an entry written by memory.write is what the CLI lists', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      await runtime.dispatcher.invoke({
        principal: ownerPrincipal('personal'),
        capabilityId: 'memory.write',
        connectionKey: 'memory.owner',
        arguments: { id: 'standup', title: 'Standup', text: 'We ship on Friday.', tags: ['team'] },
      });

      const entries = await memoryStorage.all(memoryStore(runtime, {}));

      expect(entries.map((entry) => entry.id)).toEqual(['standup']);
      expect(entries[0]?.title).toBe('Standup');
      expect(entries[0]?.tags).toEqual(['team']);
      expect(entries[0]?.body).toBe('We ship on Friday.');
    } finally {
      await runtime.close();
    }
  });

  test('a task added the CLI way is what tasks.get returns', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      await taskStorage.write(tasksStore(runtime, {}), {
        id: 'chase-the-invoice',
        title: 'Chase the invoice',
        status: 'in_progress',
        tags: ['billing'],
        due: '2026-09-01',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        body: 'Third reminder.',
      });

      const outcome = await runtime.dispatcher.invoke({
        principal: ownerPrincipal('personal'),
        capabilityId: 'tasks.get',
        connectionKey: 'tasks.owner',
        arguments: { id: 'chase-the-invoice' },
      });

      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome)).toContain('Third reminder.');
      expect(JSON.stringify(outcome)).toContain('in_progress');
    } finally {
      await runtime.close();
    }
  });

  test('a task added by tasks.add is what the CLI lists, status included', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      await runtime.dispatcher.invoke({
        principal: ownerPrincipal('personal'),
        capabilityId: 'tasks.add',
        connectionKey: 'tasks.owner',
        arguments: { id: 'ship', title: 'Ship it', status: 'blocked', tags: ['release'] },
      });

      const tasks = await taskStorage.all(tasksStore(runtime, {}));

      expect(tasks.map((task) => task.id)).toEqual(['ship']);
      expect(tasks[0]?.status).toBe('blocked');
      expect(tasks[0]?.tags).toEqual(['release']);
    } finally {
      await runtime.close();
    }
  });

  test('a file kept the CLI way is one assets.list reports', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      const store = assetsStore(runtime, {});
      await store.put('invoice.pdf', new TextEncoder().encode('%PDF-1.4'));

      const outcome = await runtime.dispatcher.invoke({
        principal: ownerPrincipal('personal'),
        capabilityId: 'assets.list',
        connectionKey: 'assets.owner',
        arguments: {},
      });

      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome)).toContain('invoice.pdf');
      expect(JSON.stringify(outcome)).toContain('application/pdf');
    } finally {
      await runtime.close();
    }
  });

  test('a file stored by assets.store is one the CLI lists', async () => {
    await workspace();
    const root = roots[roots.length - 1]!;
    const source = join(root, 'source.txt');
    await writeFile(source, 'the contents');

    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      const outcome = await runtime.dispatcher.invoke({
        principal: ownerPrincipal('personal'),
        capabilityId: 'assets.store',
        connectionKey: 'assets.owner',
        arguments: { source: { path: source } },
      });
      expect(outcome.ok).toBe(true);

      const assets = await assetStorage.all(assetsStore(runtime, {}));
      expect(assets.map((asset) => asset.name)).toEqual(['source.txt']);
      expect(assets[0]?.bytes).toBe(12);
    } finally {
      await runtime.close();
    }
  });

  test('a vault item set from the CLI is the one the vault provider reads', async () => {
    await workspace();
    const runtime = await openRuntime({ profile: 'personal', target: 'local' });

    try {
      await runtime.vault.put('owner', { id: 'github_token', value: 'ghp_secret' });

      // Not readable over MCP until the next start — ADR-012 §3 — so the check
      // that the CLI and the provider agree is the store itself, which is the
      // one both of them hold.
      expect((await runtime.vault.get('owner', 'github_token'))?.value).toBe('ghp_secret');
      expect(await runtime.vault.ids()).toEqual([{ connectionId: 'owner', id: 'github_token' }]);
    } finally {
      await runtime.close();
    }
  });

  test('a vault item set from the CLI is readable after the next start', async () => {
    // The restart is the grant. This is what makes `lanes link vault set` the operator
    // act ADR-012 §3 describes, rather than a limitation to work around.
    await workspace();

    const first = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      await first.vault.put('owner', { id: 'github_token', value: 'ghp_secret' });
      expect(first.registry.capabilities().map((entry) => entry.id)).not.toContain(
        'vault.get.github_token',
      );
    } finally {
      await first.close();
    }

    const second = await openRuntime({ profile: 'personal', target: 'local' });
    try {
      expect(second.registry.capabilities().map((entry) => entry.id)).toContain(
        'vault.get.github_token',
      );
    } finally {
      await second.close();
    }
  });
});

describe('which connection a command acts on', () => {
  const config = parseConfig(PROFILE).config;

  test('the only one, without having to name it', () => {
    // Typing --connection to reach your only memory is pure ceremony — the same
    // trade ADR-012 §1 made for prompt routing.
    expect(ownerConnection(config, 'memory', {})).toBe('owner');
  });

  test('a named one, when it exists', () => {
    expect(ownerConnection(config, 'vault', { connection: 'owner' })).toBe('owner');
  });

  test('a named one that does not exist lists what does', () => {
    expect(() => ownerConnection(config, 'vault', { connection: 'nope' })).toThrow(
      /No vault connection "nope".*have: owner/s,
    );
  });

  test('none at all says how to make one', () => {
    const bare = parseConfig(PROFILE.replace(/connections:[\s\S]*?\npolicy:/, 'policy:')).config;

    expect(() => ownerConnection(bare, 'memory', {})).toThrow(/lanes link connect memory/);
  });

  test('two is ambiguous, and refuses rather than picking', () => {
    const two = parseConfig(
      PROFILE.replace(
        '  - { id: owner, provider: memory, account: Memory }',
        '  - { id: owner, provider: memory, account: Memory }\n  - { id: work, provider: memory, account: Memory }',
      ),
    ).config;

    expect(() => ownerConnection(two, 'memory', {})).toThrow(/owner, work.*--connection/s);
  });
});
