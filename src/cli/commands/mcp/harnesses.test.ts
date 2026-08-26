import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { harnessCommands } from './harnesses.ts';
import { plannedAssets } from './assets.ts';

/**
 * The arguments handed to each harness's CLI.
 *
 * These are checked against the real `--help` output of `claude mcp add` and
 * `codex mcp add`. They differ in a way worth pinning: Claude Code takes the
 * token as a header value and stores it, while Codex takes the *name* of an
 * environment variable and reads it at launch — so the secret never reaches
 * ~/.codex/config.toml, and a rotation needs no re-registration.
 *
 * A test rather than a comment because getting one flag wrong produces a
 * registration that looks fine and fails on first use.
 */

const INPUT = {
  name: 'lanes-link',
  url: 'http://127.0.0.1:7337/mcp',
  token: 'llk_secret',
  tokenEnv: 'LANES_LINK_TOKEN',
  scope: 'user',
  profile: 'personal',
  target: 'local',
};

describe('claude', () => {
  const claude = harnessCommands('claude')!;

  test('registers an http server with a bearer header at the given scope', () => {
    expect(claude.add(INPUT)).toEqual([
      'mcp', 'add', '--transport', 'http', 'lanes-link', 'http://127.0.0.1:7337/mcp',
      '--header', 'Authorization: Bearer llk_secret',
      '--scope', 'user',
    ]);
  });

  test('get and remove take no scope, so they span all of them', () => {
    // `mcp get` accepts none, and `mcp remove` without one removes from
    // wherever it exists — which is what --force needs, or a user-scope
    // registration would survive a local-scope replace.
    expect(claude.get('lanes-link')).toEqual(['mcp', 'get', 'lanes-link']);
    expect(claude.remove('lanes-link')).toEqual(['mcp', 'remove', 'lanes-link']);
  });

  test('it stores the token, so a rotation invalidates the registration', () => {
    expect(claude.storesToken).toBe(true);
  });
});

describe('codex', () => {
  const codex = harnessCommands('codex')!;

  test('passes an env var name rather than the token', () => {
    expect(codex.add(INPUT)).toEqual([
      'mcp', 'add', 'lanes-link',
      '--url', 'http://127.0.0.1:7337/mcp',
      '--bearer-token-env-var', 'LANES_LINK_TOKEN',
    ]);
  });

  test('the token never appears in the arguments', () => {
    expect(codex.add(INPUT).join(' ')).not.toContain(INPUT.token);
  });

  test('its config is global, so scope is meaningless', () => {
    expect(codex.scoped).toBe(false);
    expect(codex.add(INPUT)).not.toContain('--scope');
  });

  test('it tells the operator to export the variable, since we cannot', () => {
    expect(codex.afterAdd?.(INPUT).join('\n')).toContain('export LANES_LINK_TOKEN=');
  });
});

describe('an unknown harness', () => {
  test('is not invented', () => {
    expect(harnessCommands('cursor')).toBeUndefined();
  });
});

/**
 * Where each harness keeps the documents we install.
 *
 * The registration half above is delegated to the harness's own CLI, so getting
 * it wrong fails loudly. This half writes files, so getting it wrong writes a
 * document into a directory nothing reads — silently. Hence the assertions.
 */
describe('the documents each harness will take', () => {
  const previous = { ...process.env };

  afterEach(() => {
    process.env['CLAUDE_CONFIG_DIR'] = previous['CLAUDE_CONFIG_DIR'];
    process.env['CODEX_HOME'] = previous['CODEX_HOME'];
    if (previous['CLAUDE_CONFIG_DIR'] === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    if (previous['CODEX_HOME'] === undefined) delete process.env['CODEX_HOME'];
  });

  test('Claude Code takes both, in its own layout', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/claude-home';
    const claude = harnessCommands('claude')!;

    expect(plannedAssets(claude, 'user').map((plan) => plan.path)).toEqual([
      join('/tmp/claude-home', 'skills', 'lanes-link', 'SKILL.md'),
      join('/tmp/claude-home', 'agents', 'lanes-link-scout.md'),
    ]);
  });

  test('Codex takes the skill and has nowhere for an agent', () => {
    // Not an omission to fix later: Codex has no subagent directory, so
    // `mcp add codex` installs one document and says so.
    process.env['CODEX_HOME'] = '/tmp/codex-home';
    const codex = harnessCommands('codex')!;
    const planned = plannedAssets(codex, 'user');

    expect(planned.map((plan) => plan.path)).toEqual([
      join('/tmp/codex-home', 'skills', 'lanes-link', 'SKILL.md'),
    ]);
    expect(codex.agents).toBeUndefined();
  });

  test('the skill layout is the same for both, so one document serves them', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/claude-home';
    process.env['CODEX_HOME'] = '/tmp/codex-home';

    const skillOf = (id: string): string | undefined =>
      plannedAssets(harnessCommands(id)!, 'user').find((plan) => plan.asset.kind === 'skill')?.path;

    expect(skillOf('claude')).toBe(join('/tmp/claude-home', 'skills', 'lanes-link', 'SKILL.md'));
    expect(skillOf('codex')).toBe(join('/tmp/codex-home', 'skills', 'lanes-link', 'SKILL.md'));
  });

  test('each home honours its own environment override', () => {
    // Read at call time, not captured at import: a value resolved when the
    // module loaded would be the real home no matter what a caller sets.
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/elsewhere';
    expect(harnessCommands('claude')!.home()).toBe('/tmp/elsewhere');

    delete process.env['CLAUDE_CONFIG_DIR'];
    expect(harnessCommands('claude')!.home()).toEndWith('/.claude');
  });

  test('a non-user scope puts them beside the checkout, not in the home', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/claude-home';
    const paths = plannedAssets(harnessCommands('claude')!, 'local').map((plan) => plan.path);

    for (const path of paths) {
      expect(path).toStartWith(join(process.cwd(), '.claude'));
    }
  });

  test('Codex ignores scope, because its config is global', () => {
    process.env['CODEX_HOME'] = '/tmp/codex-home';
    const codex = harnessCommands('codex')!;

    expect(plannedAssets(codex, 'local')).toEqual(plannedAssets(codex, 'user'));
  });
});
