import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceYaml } from '#profile/testing.ts';
import { openAudit, openSecrets, openStorage } from '#deployments/target.ts';
import { openTarget } from '#profile';
import type { AuditDraft } from '#audit';
import { createProfile } from '../profile.ts';
import { auditTail } from './audit.ts';

/**
 * `audit tail --profile` narrows the rows, and a row says which profile it is.
 *
 * Neither was true, and the two are the same defect seen from either end. The
 * log is one chain per workspace covering every profile — `selection.ts` has
 * classified `audit` as workspace-level since contract 3, and says in as many
 * words that `--profile` "filters the rows rather than choosing which log to
 * read". Nothing implemented it. `AuditQuery` had no `profile` field, so the
 * flag was accepted, dropped, and two profiles returned byte-identical rows —
 * with no column naming a profile to make that visible.
 *
 * There was no test here at all: `operate.test.ts` covers the Markdown cell
 * escaping and nothing reached this command.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Swallowed because `createProfile` writes to the reporter's own stdout. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  try {
    (process.stdout as unknown as { write: () => boolean }).write = (): boolean => true;
    return await body();
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

/** Everything the command printed, with colour left in — `style` is a no-op here. */
async function captured(body: () => Promise<void>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  try {
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
      out += chunk;
      return true;
    };
    await body();
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
  return out;
}

async function workspace(rows: readonly AuditDraft[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-audit-tail-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));

  await quietly(async () => {
    await createProfile('personal', { targets: ['local'], nonInteractive: true });
    await createProfile('work', { targets: ['local'], nonInteractive: true });
  });

  const resolved = await openTarget(root, 'local');
  const input = {
    declared: resolved.declared,
    profile: 'personal',
    root: resolved.workspaceRoot,
    target: 'local',
  };
  const sink = openAudit(await openStorage(input, await openSecrets(input)));
  for (const row of rows) await sink.append(row);
  await sink.close();

  return root;
}

function draft(overrides: Partial<AuditDraft> = {}): AuditDraft {
  return {
    profile: 'personal',
    principal: 'personal:owner',
    provider: 'lanes_memory',
    capability: 'lanes_memory.search',
    arguments: {},
    authorization: 'allowed',
    status: 'ok',
    durationMs: 3,
    ...overrides,
  };
}

describe('audit tail', () => {
  test('--profile narrows the rows rather than being accepted and ignored', async () => {
    await workspace([
      draft({ profile: 'personal', capability: 'personal.only' }),
      draft({ profile: 'work', capability: 'work.only' }),
    ]);

    const both = await captured(() => auditTail({ target: 'local' }));
    const mine = await captured(() => auditTail({ target: 'local', profile: 'work' }));

    expect(both).toContain('personal.only');
    expect(both).toContain('work.only');

    expect(mine).toContain('work.only');
    // The assertion that failed before this change: the two outputs were
    // byte-identical, so the flag looked like it had worked.
    expect(mine).not.toContain('personal.only');
    expect(mine).not.toBe(both);
  });

  test('every row names the profile it happened in', async () => {
    await workspace([
      draft({ profile: 'personal', capability: 'a' }),
      draft({ profile: 'work', capability: 'b' }),
    ]);

    const out = await captured(() => auditTail({ target: 'local' }));

    expect(out).toContain('personal');
    expect(out).toContain('work');
  });

  test('a client name cannot move the cursor over the rows above it', async () => {
    // `clientLabel` is the `client_name` a client chose at `POST /register`,
    // which is unauthenticated — so it is attacker-supplied, and this is the
    // first release that renders it here. A name carrying `ESC[2J` erases the
    // rows above it, which turns the command for seeing what an agent did into
    // somewhere to hide. `printable` replaces the controls; `stripAnsi` is not
    // this, because it leaves cursor movement alone.
    await workspace([draft({ clientLabel: 'tidy\u001b[2J\u001b[Aagent' })]);

    const out = await captured(() => auditTail({ target: 'local' }));

    expect(out).toContain('tidy');
    expect(out).not.toContain('\u001b[2J');
    expect(out).not.toContain('\u001b[A');
  });

  test('a profile with no rows says so, rather than looking like an empty log', async () => {
    await workspace([draft({ profile: 'personal' })]);

    const out = await captured(() => auditTail({ target: 'local', profile: 'work' }));

    expect(out).toContain('work');
  });
});
