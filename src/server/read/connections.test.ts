import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIONS_FILE } from '#profile';
import type { Runtime } from '#cli/runtime.ts';
import { createProfile } from '#cli/commands/profile.ts';
import { connectionRows } from './connections.ts';

/**
 * The join between what the workspace holds and what the endpoint remembers.
 *
 * One property carries this file: **`connections.yaml` decides which rows
 * exist, and the state store only decorates them.** The store is rebuilt from
 * the file by reconcile and its own header says it can be deleted and rebuilt
 * at any time, so every way it can come back short has to cost a reader the
 * dates and never the row. A listing that empties itself because a disposable
 * cache would not open is the failure this is here to prevent.
 */

const CONNECTIONS = `
  - { id: main, provider: gmail, account: first@example.com }
  - { id: side, provider: gmail, account: second@example.com }
`;

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-read-connections-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await createProfile('personal', { targets: ['local'] });

  const path = join(root, CONNECTIONS_FILE);
  const held = await Bun.file(path).text();
  await Bun.write(path, held.replace('connections:', `connections:${CONNECTIONS}`));
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A runtime with only the two things `connectionRows` reads. */
function runtime(root: string, list: () => Promise<unknown[]>): Runtime {
  return {
    resolution: { workspaceRoot: root },
    state: { connections: { list } },
  } as unknown as Runtime;
}

const record = (provider: string, id: string, created: string, updated: string) => ({
  provider,
  id,
  createdAt: new Date(created),
  updatedAt: new Date(updated),
});

describe('connectionRows', () => {
  test('a row the store knows carries its dates, as ISO 8601', async () => {
    const root = await workspace();
    const rows = await connectionRows(
      runtime(root, async () => [
        record('gmail', 'main', '2026-01-02T03:04:05.000Z', '2026-03-04T05:06:07.000Z'),
      ]),
    );

    const main = rows.find((row) => row.id === 'main');
    expect(main?.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(main?.updatedAt).toBe('2026-03-04T05:06:07.000Z');
  });

  test('a row the store has not caught up with keeps its place', async () => {
    const root = await workspace();
    const rows = await connectionRows(
      runtime(root, async () => [
        record('gmail', 'main', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
      ]),
    );

    const side = rows.find((row) => row.id === 'side');
    expect(side).toBeDefined();
    expect(side?.account).toBe('second@example.com');
    expect(side?.createdAt).toBeUndefined();
  });

  test('a store that will not open costs the dates, not the listing', async () => {
    // The one that matters. `state.kv` is disposable, and on a deployed
    // endpoint it is a bucket read that can fail on its own.
    const root = await workspace();
    const rows = await connectionRows(
      runtime(root, async () => {
        throw new Error('the bucket said no');
      }),
    );

    expect(rows.map((row) => `${row.provider}.${row.id}`)).toContain('gmail.main');
    expect(rows.map((row) => `${row.provider}.${row.id}`)).toContain('gmail.side');
    expect(rows.every((row) => row.createdAt === undefined)).toBe(true);
  });

  test('a record for a connection the file no longer declares adds no row', async () => {
    // Reconcile removes these, but it runs on a reload and this runs on every
    // request, so the file has to be the one that decides.
    const root = await workspace();
    const rows = await connectionRows(
      runtime(root, async () => [
        record('slack', 'gone', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
      ]),
    );

    expect(rows.map((row) => `${row.provider}.${row.id}`)).not.toContain('slack.gone');
  });
});
