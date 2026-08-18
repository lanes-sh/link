import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'lanes-link.yaml'), 'contract: 1\ndefault_profile: scratch\n');
    await writeFile(
      join(root, 'profiles', 'scratch.yaml'),
      `contract: 1

instance:
  profile: scratch
  default_target: local

targets:
  local:
    credentials: { adapter: file,       path: ./data/scratch.credentials.enc }
    storage:     { adapter: filesystem, path: ./data/files }
`,
    );

    // The exact shape outputs.ts builds: the bin, the area token, the command.
    const result = Bun.spawnSync(['bun', 'run', BIN, 'link', 'token', 'show', '--raw'], {
      env: { ...process.env, LANES_LINK_HOME: root },
    });

    const token = new TextDecoder().decode(result.stdout).trim();
    expect(result.exitCode).toBe(0);
    expect(token.length).toBeGreaterThan(0);
  });
});
