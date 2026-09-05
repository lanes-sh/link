import { describe, expect, test } from 'bun:test';
import { globalFlags, normaliseWorkspace, ownerFlags, parseArgv, text } from './argv.ts';
import { PROGRAM, usage } from './usage.ts';

/**
 * The parser had no tests because it could not have any: it lived inside the
 * bin entry, so importing it ran the CLI. Splitting `main.ts` is what made this
 * file possible, and the rename to `lanes link` is why it is worth having —
 * a `bin` that peels the wrong token fails in a way `bun test` never sees.
 */

describe('parseArgv', () => {
  test('separates positional words from flags', () => {
    expect(parseArgv(['vault', 'get', 'api-key'])).toEqual({
      command: ['vault', 'get', 'api-key'],
      flags: {},
    });
  });

  test('takes the next word as a flag value', () => {
    expect(parseArgv(['status', '--profile', 'work']).flags).toEqual({ profile: 'work' });
  });

  test('accepts --flag=value, so a value may start with --', () => {
    expect(parseArgv(['--title=--weird']).flags).toEqual({ title: '--weird' });
  });

  test('a flag followed by another flag is a boolean', () => {
    expect(parseArgv(['token', 'show', '--raw', '--quiet']).flags).toEqual({
      raw: true,
      quiet: true,
    });
  });

  test('a trailing flag is a boolean', () => {
    expect(parseArgv(['outputs', '--show']).flags).toEqual({ show: true });
  });
});

describe('flag shaping', () => {
  test('text() refuses a valueless flag, rather than passing true along', () => {
    // `--profile` with nothing after it parses to `true`, which is not a
    // profile name. Left unchecked it would reach resolveSelection as one.
    const { flags } = parseArgv(['status', '--profile']);
    expect(flags['profile']).toBe(true);
    expect(text(flags, 'profile')).toBeUndefined();
    expect(globalFlags(flags).profile).toBeUndefined();
  });

  test('globalFlags reads the three every command accepts', () => {
    const { flags } = parseArgv(['check', '--profile', 'work', '--target', 'cloud', '--quiet']);
    expect(globalFlags(flags)).toEqual({ profile: 'work', target: 'cloud', quiet: true });
  });

  test('ownerFlags carries the global three plus its own', () => {
    const { flags } = parseArgv(['vault', 'get', 'k', '--profile', 'work', '--show', '--yes']);
    expect(ownerFlags(flags)).toMatchObject({ profile: 'work', show: true, yes: true, raw: false });
  });

  test('the kebab-case spellings are known here and nowhere else', () => {
    const { flags } = parseArgv(['connect', 'gmail', '--display-name', 'Work mail']);
    expect(text(flags, 'display-name')).toBe('Work mail');
  });
});

describe('the program name', () => {
  test('is the two-word area spelling', () => {
    expect(PROGRAM).toBe('lanes link');
  });

  test('every command line in the usage text is spelled with it', () => {
    // The guard against a rename that edits the constant and leaves the help
    // text behind — or vice versa.
    // Pinned to eighty rather than the terminal's width: `usage` is rendered
    // now, and an inherited COLUMNS would otherwise decide what this parses.
    const commands = usage(80)
      .split('\n')
      .filter((line: string) => /^ {2}\w/.test(line));
    expect(commands.length).toBeGreaterThan(20);
    for (const line of commands) expect(line.trimStart().startsWith(PROGRAM)).toBe(true);
  });

  test('no spelling of the old name survives', () => {
    // Assembled rather than written out, so the tree-wide grep that proves the
    // old name is gone does not trip over the test that forbids it.
    const runTogether = ['lanes', 'link'].join('');
    expect(usage(80).toLowerCase()).not.toContain(runTogether);
    expect(usage(80)).not.toContain('lanes-link');
  });
});

describe('the old spelling of --workspace', () => {
  test('is read as the new one', () => {
    const said: string[] = [];
    expect(normaliseWorkspace({ target: 'cloud' }, (line) => said.push(line))).toEqual({
      workspace: 'cloud',
    });
  });

  test('says so, because a deprecation nobody sees is one nobody acts on', () => {
    // It has one minor to live, and the desktop app still passes it. The
    // warning is what tells an operator their tooling needs updating before it
    // stops working.
    const said: string[] = [];
    normaliseWorkspace({ target: 'cloud' }, (line) => said.push(line));

    expect(said.join('\n')).toContain('--target is now --workspace');
    expect(said.join('\n')).toContain('--workspace cloud');
  });

  test('says nothing when only the new spelling is used', () => {
    const said: string[] = [];
    normaliseWorkspace({ workspace: 'cloud' }, (line) => said.push(line));

    expect(said).toEqual([]);
  });

  test('both spellings agreeing is not an error', () => {
    // Redundant rather than wrong, and refusing it would break a script that
    // passes both while migrating.
    const said: string[] = [];
    expect(
      normaliseWorkspace({ target: 'cloud', workspace: 'cloud' }, (line) => said.push(line)),
    ).toEqual({ workspace: 'cloud' });
  });

  test('both spellings disagreeing is refused rather than resolved', () => {
    // Picking either would be a guess, and the two name different sets of
    // accounts.
    expect(() => normaliseWorkspace({ target: 'cloud', workspace: 'staging' }, () => {})).toThrow(
      /name different things/,
    );
  });
});
