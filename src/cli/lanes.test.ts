import { workspaceYaml } from '#profile/testing.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The `lanes` bin, spawned.
 *
 * Nothing imported `main.ts`, so no test ever exercised the entry point — a
 * broken `bin` or an argv shift would have passed a green suite. That mattered
 * little while the binary and the command were the same word; `lanes link`
 * peels a token before dispatching, and peeling the wrong one is silent.
 *
 * These three cases need no workspace, but `LANES_LINK_HOME` is set anyway:
 * `resolveWorkspaceRoot` falls back to the operator's real `~/.lanes-link`,
 * and a test must never be one bug away from reading it.
 */

const BIN = fileURLToPath(new URL('./lanes.ts', import.meta.url));
const ENV = { ...process.env, LANES_LINK_HOME: join(tmpdir(), 'lanes-link-argv-test') };

function runBin(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', 'run', BIN, ...args], { env: ENV });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe('lanes', () => {
  test('bare `lanes` lists its areas rather than failing', () => {
    const { code, stdout } = runBin([]);
    expect(code).toBe(0);
    expect(stdout).toContain('lanes link');
  });

  test('`lanes link help` reaches the link CLI', () => {
    const { code, stdout } = runBin(['link', 'help']);
    expect(code).toBe(0);
    expect(stdout).toContain('lanes link connect');
    expect(stdout).toContain('lanes link vault list');
    // The way out of a rejected password. Undiscoverable is the same as absent
    // here: the failure it recovers from is one that re-running cannot fix.
    expect(stdout).toContain('--replace');
    // The two an agent needs to find without being told they exist: what a
    // provider takes, and how to run the command with nobody there to answer.
    expect(stdout).toContain('lanes link setup plan');
    expect(stdout).toContain('--non-interactive');
  });

  test('the `link` token is consumed, not passed on as a command', () => {
    // `lanes link` with nothing after it is help, not `Unknown command "link"`.
    const { code, stdout } = runBin(['link']);
    expect(code).toBe(0);
    expect(stdout).toContain('lanes link connect');
  });

  test('an unknown area fails, and says what exists', () => {
    const { code, stderr } = runBin(['bogus']);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown area "bogus"');
    expect(stderr).toContain('link');
  });

  test('a link command still reports its own unknown subcommands', () => {
    const { code, stderr } = runBin(['link', 'vault', 'bogus']);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown: lanes link vault bogus');
  });
});

/**
 * The invocation `outputs` prints when `lanes` is not on PATH.
 *
 * It printed `bun run <...>/main.ts token show --raw` for exactly as long as
 * main.ts was the bin. Once main.ts became a module exporting `run`, that
 * command produced no output and exited 0 — so the $(…) substituted to an
 * empty string and the header became `Bearer `, which is the 401-that-looks-
 * like-a-bad-token this fallback exists to prevent. Asserted end to end
 * because the failure is invisible to every other kind of check.
 */
describe('the fallback token invocation', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  test('actually prints a token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-fallback-'));
    roots.push(root);
    await mkdir(join(root, 'profiles', 'scratch'), { recursive: true });
    await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local'], {defaultProfile: 'scratch'}));
    await writeFile(
      join(root, 'profiles', 'scratch', 'profile.yaml'),
      `contract: 5

instance:
  profile: scratch

`,
    );

    const env = { ...process.env, LANES_LINK_HOME: root };

    // A token has to be issued before it can be shown, and issuing names the
    // person it is for (ADR-068). `--subject` rather than `--me`, so the test
    // does not depend on a signed-in session.
    const issued = Bun.spawnSync(
      [
        'bun', 'run', BIN, 'link', 'token', 'issue',
        '--subject', 'lanes:scratch000', '--workspace', 'local',
      ],
      { env },
    );
    expect(issued.exitCode).toBe(0);

    // The exact shape outputs.ts builds: the bin, the command, and the one flag
    // that names where the token lives. No `--profile` — `token show` refuses
    // it, so a line carrying one would not run at all.
    const result = Bun.spawnSync(
      ['bun', 'run', BIN, 'link', 'token', 'show', '--raw', '--workspace', 'local'],
      { env },
    );

    const token = new TextDecoder().decode(result.stdout).trim();
    expect(result.exitCode).toBe(0);
    expect(token.startsWith('llk_')).toBe(true);
  });
});

describe('token rotate', () => {
  const homes: string[] = [];

  afterAll(async () => {
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  });

  async function workspace(): Promise<
    (args: string[]) => { stdout: string; stderr: string; exitCode: number }
  > {
    const home = await mkdtemp(join(tmpdir(), 'lanes-link-rotate-'));
    homes.push(home);
    const env = { ...process.env, LANES_LINK_HOME: home };
    const run = (args: string[]): { stdout: string; stderr: string; exitCode: number } => {
      const result = Bun.spawnSync(['bun', 'run', BIN, ...args], { env });
      return {
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        exitCode: result.exitCode ?? 0,
      };
    };
    run(['link', 'profile', 'add', 'scratch', '--target', 'local']);
    // A row to rotate. Issuing names the person it is for (ADR-068), and
    // `--subject` keeps this off a signed-in session.
    run(['link', 'token', 'issue', '--subject', 'lanes:scratch000', '--workspace', 'local']);
    return run;
  }

  test('does not print the new token unless asked', async () => {
    // `token show` has always truncated without `--show`, for a stated reason:
    // a token on stdout passes through an agent's context and into its
    // transcript. `rotate` mints one and printed it unconditionally, which is
    // the same disclosure at the one moment the operator is responding to a
    // leak.
    const run = await workspace();

    const rotated = run(['link', 'token', 'rotate', '--workspace', 'local']);
    const minted = run(['link', 'token', 'show', '--raw', '--workspace', 'local']).stdout.trim();

    expect(minted).toStartWith('llk_');
    expect(rotated.stdout).toContain('rotated tok1');
    expect(rotated.stdout).not.toContain(minted);
  });

  test('prints it with --show, the way `token show` does', async () => {
    const run = await workspace();

    const rotated = run(['link', 'token', 'rotate', '--show', '--workspace', 'local']);
    const minted = run(['link', 'token', 'show', '--raw', '--workspace', 'local']).stdout.trim();

    expect(rotated.stdout).toContain(minted);
  });

  test('says what holds the old value, and no longer overstates it', async () => {
    // The part that has to stay loud: nothing re-reads the token on its own.
    // Narrower than it was, and deliberately — a rotate used to invalidate every
    // agent on the endpoint because every registration carried the token.
    // Registrations do not carry one since ADR-062, so this affects only what
    // was handed this row's value.
    const run = await workspace();
    const rotated = run(['link', 'token', 'rotate', '--workspace', 'local']).stdout;

    expect(rotated).toContain('tok1');
    expect(rotated).toContain('must be given the new value');
    expect(rotated).toContain('signed in through a browser are unaffected');
  });

  test('refuses --profile, rather than accepting and ignoring it', async () => {
    // Somebody passing it believes they scoped the credential to one profile,
    // and it is the member lists that decide (ADR-068).
    const run = await workspace();
    const refused = run(['link', 'token', 'rotate', '--profile', 'scratch', '--workspace', 'local']);

    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain('does not scope');
  });
});

/**
 * `--version`, at both levels of the grammar.
 *
 * Asked for because installing from npm makes two versions of this CLI able to
 * exist on two machines at once, and a bug report that cannot name which one it
 * came from is a bug report that has to be reproduced from scratch. There was
 * no way to ask before.
 *
 * Both spellings, because both get typed: `lanes --version` is the reflex for
 * anything on a PATH, and `lanes link version` is what the grammar in this file
 * would predict. They must not be allowed to drift apart, so the test holds all
 * three — the two commands and the manifest — to one string.
 */
describe('version', () => {
  const declared = (): string => {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8')).version;
  };

  test('`lanes --version` prints the version and nothing else', () => {
    const { code, stdout } = runBin(['--version']);
    expect(code).toBe(0);
    // Bare, so `$(lanes --version)` is usable without trimming a label off it.
    expect(stdout.trim()).toBe(declared());
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('`-v` is the same thing', () => {
    expect(runBin(['-v']).stdout.trim()).toBe(declared());
  });

  test('`lanes link version` agrees with it', () => {
    const { code, stdout } = runBin(['link', 'version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(declared());
  });
});
