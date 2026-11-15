import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineProvider } from '#connectivity';
import type { ConnectionConfig } from '#profile';
import { applyReconcile, planReconcile } from '#registry';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';

/**
 * Reconcile's subject is the workspace, and every caller has to agree.
 *
 * Runtime state is one store per workspace since contract 3, and reconcile
 * disables everything in that store the connection list does not declare. So
 * the list handed to it decides what survives, and handing it one profile's
 * grants means every account only the *other* profiles granted reads as
 * undeclared.
 *
 * `openReconciled` learned this the hard way — two profiles was enough for the
 * second pass to disable the first's accounts, every later call refused
 * `denied_connection_unauthorized`, and a restart flipped which profile won —
 * and it passes `workspaceConnections`. The CLI kept calling with
 * `grantedConnections`, so `lanes link plan --profile <narrow>` proposed
 * disabling twelve accounts belonging to profiles it was not even asked about,
 * and `doctor` pointed an operator at that plan as the remedy for drift it had
 * invented by asking the wrong question.
 */

const manifestFor = (provider: string) =>
  defineProvider({
    id: provider,
    name: provider,
    connector: { kind: 'mcp', endpoint: 'https://upstream.test/mcp' },
    auth: { kind: 'oauth' },
  });

const connection = (provider: string, id: string): ConnectionConfig =>
  ({ provider, id, account: `${provider} ${id}` }) as ConnectionConfig;

/** Everything the workspace holds: one account per profile, plus a shared one. */
const WORKSPACE = [
  connection('gmail', 'ada_lovelace'),
  connection('notion', 'work'),
  connection('calendar', 'shared'),
];

/** What one narrow profile was granted out of it. */
const NARROW = [connection('calendar', 'shared')];

describe('what reconcile is measured against', () => {
  test('a profile-scoped list disables the accounts the other profiles hold', async () => {
    // The hazard itself, stated as a test so the next person does not have to
    // reproduce it on a real workspace to believe it.
    const state = createMemoryState();
    const credentials = createMemoryCredentials({
      'gmail/ada_lovelace': 'x',
      'notion/work': 'x',
      'calendar/shared': 'x',
    });

    const seeded = await planReconcile(WORKSPACE, state, credentials, manifestFor);
    await applyReconcile(WORKSPACE, state, seeded);

    const narrow = await planReconcile(NARROW, state, credentials, manifestFor);

    expect([...narrow.undeclared].sort()).toEqual(['gmail.ada_lovelace', 'notion.work']);
    expect(narrow.actions).toContainEqual(
      expect.objectContaining({ kind: 'disable', connection: 'gmail.ada_lovelace' }),
    );
  });

  test('the whole workspace list leaves them alone', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials({
      'gmail/ada_lovelace': 'x',
      'notion/work': 'x',
      'calendar/shared': 'x',
    });

    const seeded = await planReconcile(WORKSPACE, state, credentials, manifestFor);
    await applyReconcile(WORKSPACE, state, seeded);

    const again = await planReconcile(WORKSPACE, state, credentials, manifestFor);

    expect(again.undeclared).toEqual([]);
    expect(again.actions.every((action) => action.kind === 'unchanged')).toBe(true);
  });

  test('no caller reconciles against one profile grants', () => {
    // Read rather than mocked, the way `selection.test.ts` reads the dispatch
    // files: the rule is about which list reaches `planReconcile`, and a test
    // that stubbed the runtime would assert the stub.
    const source = readFileSync(join(import.meta.dir, 'inspect.ts'), 'utf8');

    const calls = [...source.matchAll(/planReconcile\(\s*([A-Za-z.()\s]+?)\s*,/g)].map(
      (match) => match[1]?.replace(/\s+/g, '') ?? '',
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const argument of calls) {
      expect(argument).not.toContain('grantedConnections');
      expect(argument).toContain('workspaceConnections');
    }
  });
});
