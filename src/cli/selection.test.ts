import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SELECTION, assertKnownFlags, requirementFor } from './selection.ts';
import { requireSelection } from './selection-require.ts';
import { CONNECT_CUSTOM_FLAGS, RESERVED_BY_GRAMMAR } from './commands/connect/custom/spec.ts';

/**
 * That every command says what it needs, and that nothing can be added without
 * saying.
 *
 * The bug this file exists for is not a wrong answer, it is a missing one:
 * `main.ts` built an options literal for `profile add` and dropped `--target`
 * into it, and nothing refused because nothing held a list of what the command
 * accepts. A table only helps if it cannot fall behind the grammar, so the first
 * test reads `main.ts` rather than trusting anyone to keep two files in step.
 */

/**
 * Every file holding part of the grammar.
 *
 * `main.ts` alone until the owner commands moved out. Reading both matters more
 * than it looks: this test is the reason a new command cannot default quietly,
 * and a dispatch that had grown a second file would have gone unread — the
 * check would keep passing while covering less.
 */
const DISPATCH = ['main.ts', 'dispatch-owner.ts'].map((name) => join(import.meta.dir, name));

/** Every `case 'x':` in the dispatch, in order, so nesting can be reconstructed. */
async function dispatchedCommands(): Promise<Set<string>> {
  const source = (await Promise.all(DISPATCH.map((path) => readFile(path, 'utf8')))).join('\n');
  const found = new Set<string>();

  // The outer switch is on `first` and each nested one on `second`; indentation
  // is what tells them apart, and it is stable because the file is formatted.
  let outer: string | undefined;
  for (const line of source.split('\n')) {
    const top = /^ {4}case '([a-z-]+)':/.exec(line);
    if (top) {
      outer = top[1]!;
      found.add(outer);
      continue;
    }

    const nested = /^ {8}case '([a-z-]+)':/.exec(line);
    if (nested && outer) found.add(`${outer} ${nested[1]!}`);
  }

  return found;
}

describe('every dispatched command declares what it needs', () => {
  test('the table covers the grammar, so a new command cannot default quietly', async () => {
    const dispatched = await dispatchedCommands();

    // A command may be absent from SELECTION only if its bare form is present:
    // `memory get` inherits from `memory`, which is the point of the fallback.
    const uncovered = [...dispatched].filter((command) => {
      if (command in SELECTION) return false;
      const [first] = command.split(' ');
      return !(first! in SELECTION);
    });

    expect(uncovered).toEqual([]);
  });

  test('an unrecognised command still gets the strict default', () => {
    // Not an oversight, and the safe direction: a command nobody classified
    // asks for both rather than silently opening whatever it likes.
    expect(requirementFor('something-new', undefined)).toBe('profile+target');
  });
});

// A workspace that does not exist: these assert *which* refusal is reached, and
// the listings inside it are `#profile`'s to get right — `workspace.test` and
// `targets.test` cover the wording.
const nowhere = { LANES_LINK_HOME: '/nonexistent-workspace-for-a-test' };

describe('requiring a selection', () => {

  test('refuses a command that names no profile, once it has a target', async () => {
    // `connect` acts on one account, so the profile is the subject and there is
    // nothing to fall back to. `status` used to stand here and no longer can:
    // its subject is the target (ADR-043).
    //
    // The target has to be given first, and that is the ordering ADR-052
    // inverted: a profile lives in one target's workspace, so "which profiles
    // exist" cannot be answered — or refused usefully — until the target is
    // known.
    await expect(
      requireSelection('connect', undefined, { target: 'local' }, nowhere),
    ).rejects.toThrow('--profile is required');
  });

  test('asks for the target before the profile, because the target says where to look', async () => {
    await expect(requireSelection('connect', undefined, {}, nowhere)).rejects.toThrow(
      '--target is required',
    );
  });

  test('asks a target-scoped command for a target, and not for a profile', async () => {
    await expect(requireSelection('status', undefined, {}, nowhere)).rejects.toThrow(
      '--target is required',
    );
    await expect(
      requireSelection('status', undefined, { target: 'cloud' }, nowhere),
    ).resolves.toBeUndefined();
  });

  test('and still accepts --profile there, as a filter', async () => {
    await expect(
      requireSelection('status', undefined, { target: 'cloud', profile: 'work' }, nowhere),
    ).resolves.toBeUndefined();
    expect(() =>
      assertKnownFlags('status', undefined, { target: 'cloud', profile: 'work' }),
    ).not.toThrow();
  });

  test('asks the store-free commands for both, because the target locates the file', async () => {
    // `check` validates a YAML file, `config show` prints the whole of it, and
    // `policy list` reads a block that is the same wherever the profile runs.
    // None opens a store — and all three still need a target now, because a
    // profile lives in exactly one target's workspace and without one there is
    // no file to read (ADR-052). The flag buys finding it, not opening it.
    for (const command of ['check', 'config show', 'policy list'] as const) {
      const [first, second] = command.split(' ');
      await expect(requireSelection(first!, second, { profile: 'work' }, nowhere)).rejects.toThrow(
        '--target is required',
      );
      await expect(
        requireSelection(first!, second, { profile: 'work', target: 'local' }, nowhere),
      ).resolves.toBeUndefined();
    }
  });

  test('asks target list for no target at all', async () => {
    // It is the command you run to find out what to pass. Requiring the answer
    // as input would be circular.
    await expect(
      requireSelection('target', 'list', { profile: 'work' }, nowhere),
    ).resolves.toBeUndefined();
  });

  test('accepts a command that names both', async () => {
    await expect(
      requireSelection('status', undefined, { profile: 'work', target: 'cloud' }, nowhere),
    ).resolves.toBeUndefined();
  });

  test('asks profile add for a target, because that is where the file goes', async () => {
    // It named neither while every profile was written into the same directory.
    // `--target` now decides *which workspace* it is created in (ADR-052), so it
    // is the one thing the command cannot proceed without. The profile name is
    // still positional.
    await expect(requireSelection('profile', 'add', {}, nowhere)).rejects.toThrow(
      '--target is required',
    );
    await expect(
      requireSelection('profile', 'add', { target: 'local' }, nowhere),
    ).resolves.toBeUndefined();
  });

  test('says nothing when the subcommand itself does not exist', async () => {
    // The switch has a better sentence for that, and complaining about
    // --profile on a command that does not exist sends someone to fix the
    // wrong thing.
    await expect(requireSelection('vault', 'bogus', {}, nowhere)).resolves.toBeUndefined();
  });
});

describe('refusing a flag the command does not read', () => {
  test('names the flag and what is accepted', () => {
    expect(() => assertKnownFlags('status', undefined, { nonsense: true })).toThrow(
      'Unknown flag "--nonsense"',
    );
  });

  test('guesses at a near miss, which is what makes a required flag survivable', () => {
    // Without this, requiring --profile makes a typo *worse*: `--porfile work`
    // used to fall through to a default and mostly work, and would now produce
    // "--profile is required" while naming a flag the operator did pass.
    expect(() => assertKnownFlags('status', undefined, { porfile: 'work' })).toThrow(
      'Did you mean --profile?',
    );
    expect(() => assertKnownFlags('status', undefined, { taget: 'cloud' })).toThrow(
      'Did you mean --target?',
    );
  });

  test('does not guess when nothing is close', () => {
    expect(() => assertKnownFlags('status', undefined, { wildlyoff: true })).toThrow(
      'Unknown flag',
    );
    expect(() => assertKnownFlags('status', undefined, { wildlyoff: true })).not.toThrow(
      'Did you mean',
    );
  });

  test('refuses --target on a command with nothing to select', () => {
    // The reported bug, as a test: `profile add work --target cloud` printed ok
    // and dropped the flag. It now declares a target rather than selecting one,
    // so it is accepted here — but a profile flag is not.
    expect(() => assertKnownFlags('profile', 'add', { target: 'cloud' })).not.toThrow();
    expect(() => assertKnownFlags('profile', 'add', { profile: 'work' })).toThrow('Unknown flag');
  });

  test('lets every command take --json, --help and --quiet', () => {
    expect(() =>
      assertKnownFlags('status', undefined, { json: true, help: true, quiet: true }),
    ).not.toThrow();
  });

  test('lets a command take its own flags', () => {
    expect(() =>
      assertKnownFlags('connect', undefined, { id: 'main', 'own-client': true }),
    ).not.toThrow();
    expect(() => assertKnownFlags('deploy', undefined, { 'dry-run': true })).not.toThrow();
  });

  test('but not another command’s', () => {
    expect(() => assertKnownFlags('status', undefined, { 'dry-run': true })).toThrow('Unknown flag');
  });
});

/**
 * That every command can actually be run in the spelling it demands.
 *
 * The table said `profile` for five commands and their handlers called
 * `resolveProfile`, which requires a target — while `assertKnownFlags` refused
 * `--target` because the table said they did not take one. Every one of them was
 * unrunnable in both spellings at once:
 *
 *     $ lanes link check --profile personal
 *     error  --target is required.
 *     $ lanes link check --profile personal --target local
 *     error  Unknown flag "--target" for "lanes link check".
 *
 * A requirement and an allowlist that disagree cannot be caught by testing
 * either one, which is why this asserts the pair — and asserts it over the whole
 * table rather than a list somebody has to remember to extend. ADR-052 moved
 * eight commands between levels; this is what would have caught it if any of
 * them had been moved in one place and not the other.
 */
describe('every command is runnable in the spelling it demands', () => {
  const twoWord = new Set(Object.keys(SELECTION).filter((key) => key.includes(' ')));

  const commands = Object.keys(SELECTION).map((key) => {
    const [first, second] = key.split(' ');
    return { key, first: first!, second, requires: SELECTION[key]! };
  });

  test('what the requirement demands, the allowlist accepts', () => {
    for (const { key, first, second, requires } of commands) {
      // A one-word key that also has two-word rows dispatches to those; asking
      // it for flags is a different question, answered by its own row.
      if (requires === 'none') continue;

      const flags: Record<string, string> = {};
      if (requires === 'profile+target') flags['profile'] = 'work';
      if (requires === 'target' || requires === 'profile+target') flags['target'] = 'local';

      expect(() => assertKnownFlags(first, second, flags), `${key} accepts what it requires`).not.toThrow();
    }
  });

  test('and nothing demands a flag it would then refuse', async () => {
    for (const { key, first, second, requires } of commands) {
      if (requires === 'none') continue;
      if (twoWord.has(key) && second === undefined) continue;

      const flags: Record<string, string> = {};
      if (requires === 'profile+target') flags['profile'] = 'work';
      if (requires === 'target' || requires === 'profile+target') flags['target'] = 'local';

      await expect(
        requireSelection(first, second, flags, nowhere),
        `${key} is satisfied by ${JSON.stringify(flags)}`,
      ).resolves.toBeUndefined();
    }
  });

  test('the five store-free commands moved to profile+target together', () => {
    // They read one profile's file and open nothing, which is why they never
    // needed a target. They need one now to *find* the file (ADR-052) — and the
    // point of naming them here is that moving four of the five would leave the
    // fifth quietly unrunnable.
    for (const key of ['check', 'config show', 'policy list', 'secrets push', 'identity list']) {
      expect(SELECTION[key], key).toBe('profile+target');
    }
  });

  test('profile remove names its profile positionally, like profile add', async () => {
    // Both take the name as an argument, so a `--profile` flag could only name a
    // second one and disagree with it.
    await expect(
      requireSelection('profile', 'remove', { target: 'local' }, nowhere),
    ).resolves.toBeUndefined();
    expect(() => assertKnownFlags('profile', 'remove', { profile: 'work' })).toThrow('Unknown flag');
  });

  test('profile remove takes the --target that says which workspace holds it', () => {
    // It used to mean "decommission this one target's stores and keep the
    // profile". It now says where the profile *is* (ADR-052), and is required
    // rather than optional.
    expect(() =>
      assertKnownFlags('profile', 'remove', { target: 'cloud', 'dry-run': true }),
    ).not.toThrow();
  });

  /**
   * `connect custom` is a second word of `connect`, and its own row.
   *
   * The row is the whole mechanism: `selectionKey` returns a two-word key only
   * when `SELECTION` holds one, and that is what gives the command its own
   * `ACCEPTS` entry. Without it the thirty declaration flags would have to join
   * `connect`'s list, where `--openapi` on `connect gmail` would be accepted and
   * silently ignored — the defect this file exists for.
   */
  test('connect custom takes its own flags', () => {
    expect(() =>
      assertKnownFlags('connect', 'custom', {
        connector: 'mcp',
        endpoint: 'https://mcp.example.com/mcp',
        auth: 'bearer',
        'replace-manifest': true,
      }),
    ).not.toThrow();
  });

  test('and they stay off connect <provider>, which is why it has a row', () => {
    expect(() => assertKnownFlags('connect', 'gmail', { connector: 'mcp' })).toThrow(
      'Unknown flag "--connector"',
    );
    expect(() => assertKnownFlags('connect', 'gmail', { 'replace-manifest': true })).toThrow(
      'Unknown flag',
    );
  });

  test('connect custom does not take --own-client, which would be inert', () => {
    // It selects between an operator's OAuth client and a broker's, and a
    // synthesized manifest never declares a broker.
    expect(() => assertKnownFlags('connect', 'custom', { 'own-client': true })).toThrow(
      'Unknown flag',
    );
  });

  test('and it needs both a profile and a target, like connect', async () => {
    // The target first, because it is what says which workspace holds the
    // profile (ADR-052) — so a command naming neither is refused for the target.
    await expect(requireSelection('connect', 'custom', {}, nowhere)).rejects.toThrow(
      '--target is required',
    );
    await expect(
      requireSelection('connect', 'custom', { target: 'local' }, nowhere),
    ).rejects.toThrow('--profile is required');
    await expect(
      requireSelection('connect', 'custom', { profile: 'work', target: 'local' }, nowhere),
    ).resolves.toBeUndefined();
  });

  test('every flag customFlags reads is a flag connect custom accepts', () => {
    // Two files, one list: `argv.ts` spells the kebab-case names and
    // `spec.ts` allowlists them. They drifted apart once for `--own-client`.
    const source = readFileSync(join(import.meta.dir, 'argv.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function customFlags'));

    const read = [
      ...body.matchAll(/(?:text\(flags, |all\(argv, )'([a-z-]+)'/g),
      ...body.matchAll(/flags\['([a-z-]+)'\]/g),
    ].map((match) => match[1]!);

    expect(read.length).toBeGreaterThan(20);
    expect(read.filter((flag) => !CONNECT_CUSTOM_FLAGS.includes(flag))).toEqual([]);
  });

  test('every id the grammar reserves is actually a second word of connect', () => {
    // The constant is what refuses `providers.d/custom.yaml` at load. If the
    // spelling of the command ever changed, it would go on refusing a name
    // nothing takes.
    for (const id of RESERVED_BY_GRAMMAR) {
      expect(`connect ${id}` in SELECTION).toBe(true);
    }
  });

  test('the flags a command reads are flags it accepts', () => {
    // Both were read by the parser and absent from the allowlist, so passing
    // either was refused on a command documented as taking it.
    expect(() => assertKnownFlags('memory', 'list', { tag: 'x' })).not.toThrow();
    expect(() => assertKnownFlags('mcp', 'list', { name: 'x', scope: 'user' })).not.toThrow();
    // Three of these are repeatable and read from argv rather than from the
    // parsed map, which is exactly the shape that gets left out of the
    // allowlist because the parser never complained about it.
    expect(() =>
      assertKnownFlags('entities', 'write', {
        type: 'person',
        alias: 'JB',
        attr: 'email=jan@example.test',
        related: 'works_at=acme-bv',
        name: 'jan-bakker',
      }),
    ).not.toThrow();
  });
});

describe('the grammar is read wherever it lives', () => {
  test('a command dispatched outside main.ts is still covered', async () => {
    // `memory get` and `vault key` moved to `dispatch-owner.ts`. If this test
    // only read `main.ts` it would pass by not looking.
    const dispatched = await dispatchedCommands();

    for (const command of ['memory get', 'skills add', 'vault key', 'entities find']) {
      expect(dispatched.has(command)).toBe(true);
    }
  });
});
