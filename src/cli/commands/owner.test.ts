import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '#profile';
import { memoryStorage } from '#providers/owner.ts';
import { openRuntime, ownerPrincipal } from '../runtime.ts';
import { memoryStore, ownerConnection } from './owner.ts';

/**
 * `lanes link memory` / `lanes link skills` / `lanes link vault`.
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

connections:
  - { id: owner, provider: memory, account: Owner }
  - { id: owner, provider: skills, account: Owner }
  - { id: owner, provider: vault,  account: Owner }

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
    const runtime = await openRuntime({});

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
    const runtime = await openRuntime({});

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

  test('a vault item set from the CLI is the one the vault provider reads', async () => {
    await workspace();
    const runtime = await openRuntime({});

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

    const first = await openRuntime({});
    try {
      await first.vault.put('owner', { id: 'github_token', value: 'ghp_secret' });
      expect(first.registry.capabilities().map((entry) => entry.id)).not.toContain(
        'vault.get.github_token',
      );
    } finally {
      await first.close();
    }

    const second = await openRuntime({});
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
        '  - { id: owner, provider: memory, account: Owner }',
        '  - { id: owner, provider: memory, account: Owner }\n  - { id: work, provider: memory, account: Work }',
      ),
    ).config;

    expect(() => ownerConnection(two, 'memory', {})).toThrow(/owner, work.*--connection/s);
  });
});
