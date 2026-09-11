import { describe, expect, test } from 'bun:test';

import { runAuth } from './auth-dispatch.ts';

/**
 * `lanes auth` refuses a flag it does not read.
 *
 * It did not, for a structural reason rather than an oversight: `lanes.ts`
 * routes this area before `main.ts`, and `assertKnownFlags` is called inside
 * `main.ts`. So the check that covers every `link` command never saw this one,
 * and `parseArgv` hands back every `--anything` it finds.
 *
 * Every case here refuses before any command runs, so none of them reads a
 * session, opens a browser, or writes anything.
 */
describe('lanes auth refuses a flag it does not read', () => {
  test('the misspelling that was silently dropped', async () => {
    // `login` would otherwise fall back to `LANES_API_URL` and then to the
    // default broker, and nothing it prints names which one it used.
    await expect(runAuth(['login', '--api_url', 'https://example.invalid'])).rejects.toThrow(
      'Did you mean --api-url?',
    );
  });

  test('and any other unknown flag', async () => {
    await expect(runAuth(['status', '--workspace', 'cloud'])).rejects.toThrow(
      'Unknown flag "--workspace" for "lanes auth status"',
    );
  });

  test('the command it names is the one that was typed', async () => {
    await expect(runAuth(['workspaces', '--nope'])).rejects.toThrow('"lanes auth workspaces"');
    await expect(runAuth(['--nope'])).rejects.toThrow('"lanes auth"');
  });

  test('--help is answered rather than allowed through', async () => {
    // Allowlisting it without answering it would be the same defect: before
    // this, `lanes auth --help` printed the status.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string): void => void lines.push(line);
    try {
      await runAuth(['--help']);
    } finally {
      console.log = original;
    }

    expect(lines.join('\n')).toContain('lanes auth login');
    expect(lines.join('\n')).toContain('--api-url <url>');
  });
});
