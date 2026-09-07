import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `lanes link connection declare`, end to end through the real binary.
 *
 * Spawned rather than called, because half of what this command is depends on
 * wiring that a direct call skips: the `connection declare` case in `main.ts`,
 * the row in `SELECTION`, and the `ACCEPTS` entry that decides whether
 * `--account` is a flag or an error. A unit test of the exported function would
 * pass with all three missing.
 *
 * What is being asserted is that two files change and a third thing does not:
 * the workspace gains a connection row, the named profile gains a grant row,
 * and no credential is stored or asked for. `server/mcp/unauthorized.test.ts`
 * holds the other half — that a grant in that state is advertised — and the two
 * together are the whole of why this command exists (ADR-075).
 */

const BIN = fileURLToPath(new URL('../lanes.ts', import.meta.url));

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

interface Run {
  readonly code: number;
  readonly out: string;
}

async function workspace(): Promise<{ root: string; run: (args: string[]) => Run }> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-declare-'));
  homes.push(root);
  const env = { ...process.env, LANES_LINK_HOME: root };

  const run = (args: string[]): Run => {
    const result = Bun.spawnSync(['bun', 'run', BIN, 'link', ...args], { env });
    return {
      code: result.exitCode,
      out:
        new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
    };
  };

  expect(run(['profile', 'add', 'assistant', '--workspace', 'local']).code).toBe(0);
  return { root, run };
}

describe('declaring an account before authorising it', () => {
  test('writes the connection row and the profile grant, and no credential', async () => {
    const { root, run } = await workspace();

    const declared = run([
      'connection', 'declare', 'gmail',
      '--account', 'ada.lovelace@example.com',
      '--profile', 'assistant',
      '--workspace', 'local',
    ]);

    expect(declared.code).toBe(0);
    expect(declared.out).toContain('declared gmail.main');

    const connections = await readFile(join(root, 'connections.yaml'), 'utf8');
    expect(connections).toContain('provider: gmail');
    expect(connections).toContain('account: ada.lovelace@example.com');

    const profile = await readFile(join(root, 'profiles', 'assistant', 'profile.yaml'), 'utf8');
    expect(profile).toContain('connection: gmail.main');
    expect(profile).toContain('gmail.*');

    // The claim that makes this different from `connect`. `credential_ref`
    // derives to `<provider>/<id>`, so the absence being asserted is the stored
    // value, and `doctor` is what reports it as missing.
    expect(run(['doctor', '--profile', 'assistant', '--workspace', 'local']).out).toContain(
      'gmail.main has no stored credential',
    );
  });

  /**
   * Without `--profile` nothing is granted, and the output says so rather than
   * reporting success at the thing the operator ran it for. Declaring is not
   * granting, the same way connecting is not (ADR-057) — and only the grant row
   * changes what a client is served.
   */
  test('declares into the workspace and grants nothing when no profile is named', async () => {
    const { root, run } = await workspace();

    const declared = run([
      'connection', 'declare', 'gmail',
      '--account', 'ada.lovelace@example.com',
      '--workspace', 'local',
    ]);

    expect(declared.code).toBe(0);
    expect(declared.out).toContain('Granted to nobody');

    expect(await readFile(join(root, 'connections.yaml'), 'utf8')).toContain('provider: gmail');
    expect(
      await readFile(join(root, 'profiles', 'assistant', 'profile.yaml'), 'utf8'),
    ).not.toContain('gmail.main');
  });

  /**
   * The account cannot be probed, because probing is what needs the credential
   * this command is defined by not having (ADR-073). So it is asked for, and the
   * refusal has to say that rather than name a missing flag — an operator who
   * has just been told to declare a provider does not know why an address is
   * suddenly required.
   */
  test('refuses without an account, and says why one is needed', async () => {
    const { run } = await workspace();

    const refused = run([
      'connection', 'declare', 'gmail', '--profile', 'assistant', '--workspace', 'local',
    ]);

    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('Which account is this Gmail connection?');
    expect(refused.out).toContain('until it is authorised');
  });

  /** A second row for the same id is the operator's mistake, not a reconnect. */
  test('refuses a second declaration of the same connection', async () => {
    const { run } = await workspace();
    const args = [
      'connection', 'declare', 'gmail',
      '--account', 'ada.lovelace@example.com',
      '--workspace', 'local',
    ];

    expect(run(args).code).toBe(0);

    const again = run(args);
    expect(again.code).not.toBe(0);
    expect(again.out).toContain('already holds gmail.main');
    // Both ways forward, because either could be what was meant.
    expect(again.out).toContain('lanes link connect gmail');
    expect(again.out).toContain('--id <another>');
  });

  /**
   * The owner layer is instances written by `ensureOwnerLayer` (ADR-059), so a
   * hand-declared row for one would collide with the repair rather than replace
   * it — and every profile already holds them (ADR-050), so there is nothing to
   * declare.
   */
  test('refuses one of Lanes own surfaces', async () => {
    const { run } = await workspace();

    const refused = run([
      'connection', 'declare', 'lanes_memory',
      '--account', 'ada.lovelace@example.com',
      '--workspace', 'local',
    ]);

    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("one of Lanes' own surfaces");
  });

  test('refuses a provider this build does not know', async () => {
    const { run } = await workspace();

    const refused = run([
      'connection', 'declare', 'not_a_vendor',
      '--account', 'someone@example.com',
      '--workspace', 'local',
    ]);

    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('No provider "not_a_vendor"');
  });
});
