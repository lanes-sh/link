import { describe, expect, test } from 'bun:test';
import type { Flags } from './argv.ts';
import { ASSETS, readAsset } from './commands/mcp/assets.ts';
import { assertKnownFlags, requirementFor, selectionKey } from './selection.ts';
import { PROGRAM, USAGE } from './usage.ts';

/**
 * The documents we install into someone's agent must describe this CLI.
 *
 * Same lesson as `src/profile/docs.test.ts`, applied where the copy-paste is
 * done by a language model rather than a person: a skill that names a command
 * which does not exist is worse than no skill, because the agent will run it
 * confidently and report the failure as the user's problem. Checking here means
 * the next rename either updates these documents or fails.
 */

/** Every `lanes link <something>` a document tells an agent to run. */
function commandsNamedIn(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(new RegExp(`${PROGRAM} ([a-z]+(?: [a-z]+)?)`, 'g'))) {
    found.add(match[1]!);
  }

  return [...found].sort();
}

/** The command paths `USAGE` documents, as `"mcp add"` and `"start"`. */
const documented = new Set(
  USAGE.split('\n')
    .map((line) => line.trim())
    // The title line spells PROGRAM in bold, so it carries ANSI codes and does
    // not match — which is right: it is a heading, not a command.
    .filter((line) => line.startsWith(PROGRAM))
    .flatMap((line) => {
      const words = line.slice(PROGRAM.length).trim().split(/\s+/);
      const first = words[0];
      const second = words[1];
      if (!first || first.startsWith('-') || first.startsWith('<')) return [];
      return second && /^[a-z]+$/.test(second) ? [first, `${first} ${second}`] : [first];
    }),
);

/**
 * Every `lanes link …` invocation a document shows, as its own argv.
 *
 * Two passes, because the two places a command appears break differently.
 * Inline code spans are matched whole rather than line by line: the prose wraps
 * at the same width as everything else, so a command inside one pair of
 * backticks may straddle two source lines — `identity add` does — and reading
 * lines would drop the flags onto the floor and then report them missing. A
 * fenced block has no backticks to bound a span, so those are read a line at a
 * time, which is how they are written anyway.
 *
 * `PROGRAM` is searched for inside each candidate rather than anchored at its
 * start, so the `$(lanes link token show …)` substitutions count too. Those are
 * the invocations most worth checking, since they are meant to be pasted.
 */
function invocationsIn(text: string): Invocation[] {
  const found: Invocation[] = [];
  const lines = text.split('\n');

  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;

  const candidates: Array<{ text: string; index: number }> = [];

  // Fenced blocks are blanked out before the span pass, keeping every offset
  // where it was. A fence is three backticks, so a span regex left to itself
  // pairs the third with the first of the closing fence and swallows the block
  // whole — reporting each command in it against the fence's own line.
  const masked: string[] = [];
  let fenced = false;

  for (const [number, line] of lines.entries()) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      masked.push(' '.repeat(line.length));
      continue;
    }

    masked.push(fenced ? ' '.repeat(line.length) : line);
    if (fenced) candidates.push({ text: line, index: offsets[number]! });
  }

  for (const match of masked.join('\n').matchAll(/`([^`]+)`/g)) {
    candidates.push({ text: match[1]!, index: match.index! });
  }

  for (const candidate of candidates) {
    let from = candidate.text.indexOf(`${PROGRAM} `);
    while (from !== -1) {
      const argv = tokenise(candidate.text.slice(from + PROGRAM.length));
      if (argv.length > 0) {
        found.push({ argv, line: lineOf(candidate.index), shown: `${PROGRAM} ${argv.join(' ')}` });
      }
      from = candidate.text.indexOf(`${PROGRAM} `, from + 1);
    }
  }

  return found;
}

interface Invocation {
  readonly argv: readonly string[];
  /** 1-indexed, so a failure names a line the reader can open. */
  readonly line: number;
  readonly shown: string;
}

/**
 * One invocation's argv, stopping where the command does.
 *
 * A trailing comment is dropped, and so is the punctuation a command picks up
 * from the sentence or the shell around it — `<name>)"` closing a substitution,
 * or a full stop ending the line it sits on.
 */
function tokenise(tail: string): string[] {
  const argv: string[] = [];

  for (const raw of tail.replace(/\s+/g, ' ').trim().split(' ')) {
    if (raw === '#' || raw.startsWith('#')) break;
    const token = raw.replace(/^[`"'(]+/, '').replace(/[`"'),.;]+$/, '');
    if (token === '' || token === '\\') continue;
    argv.push(token);
  }

  return argv;
}

/** The flags an invocation shows, in the shape `assertKnownFlags` reads. */
function flagsOf(argv: readonly string[]): Flags {
  const flags: Flags = {};

  for (const [index, token] of argv.entries()) {
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    flags[token.slice(2)] = next && !next.startsWith('-') ? next : true;
  }

  return flags;
}

/**
 * How many tokens of an invocation are the command path itself.
 *
 * A bare second word is part of the path even where `SELECTION` does not spell
 * the pair out — `memory list` inherits from `memory`, and reading `list` as an
 * argument turned a mention of the command into a whole invocation that was
 * then reported for missing the flags a mention has no business carrying.
 */
function pathLength(argv: readonly string[]): number {
  const second = argv[1];
  return selectionKey(argv[0]!, second).includes(' ') || /^[a-z]+$/.test(second ?? '') ? 2 : 1;
}

/**
 * Whether this occurrence is the labelled wrong half of a comparison.
 *
 * Same convention the token test below relies on, and for the same reason: a
 * document that may only show correct commands cannot teach the difference
 * between a right and a wrong one.
 */
function underWrongLabel(text: string, line: number): boolean {
  const lines = text.split('\n');
  return `${lines[line - 2] ?? ''}\n${lines[line - 1] ?? ''}`.includes('WRONG');
}

describe.each(ASSETS.map((asset) => [asset.label, asset] as const))('the bundled %s', (_label, asset) => {
  test('names only commands this CLI actually has', async () => {
    const named = commandsNamedIn(await readAsset(asset));
    const unknown = named.filter((command) => {
      // "mcp add" is documented; "mcp" alone is reached via "mcp add".
      const [head] = command.split(' ');
      return !documented.has(command) && !documented.has(head!);
    });

    expect(unknown).toEqual([]);
  });

  test('names at least one, or the check above passed on an empty list', async () => {
    expect(commandsNamedIn(await readAsset(asset)).length).toBeGreaterThan(0);
  });

  test('never shows a flag its command refuses', async () => {
    // `assertKnownFlags` is the function the CLI refuses with, so this cannot
    // disagree with the binary about what a command accepts. It is the half of
    // ADR-037 the earlier check missed: naming a real command is not the same as
    // naming it correctly, and `profile add --profile` is a real command with a
    // flag that is rejected before dispatch.
    const text = await readAsset(asset);
    const refused: string[] = [];

    for (const shown of invocationsIn(text)) {
      try {
        assertKnownFlags(shown.argv[0]!, shown.argv[1], flagsOf(shown.argv));
      } catch (error) {
        refused.push(`line ${shown.line}: ${shown.shown} — ${(error as Error).message.split('\n')[0]}`);
      }
    }

    expect(refused).toEqual([]);
  });

  test('shows every flag its command requires, wherever it shows a whole command', async () => {
    // Only where something follows the command path. A bare `lanes link deploy`
    // in a sentence names the command; `lanes link deploy --dry-run` is meant to
    // be run, and one missing `--target` makes it a line the owner pastes and
    // watches refuse. ADR-043 is why this cannot simply demand both everywhere:
    // `status`, `deploy` and `sync targets` take a target and no profile.
    const text = await readAsset(asset);
    const incomplete: string[] = [];

    for (const shown of invocationsIn(text)) {
      if (shown.argv.length <= pathLength(shown.argv)) continue;
      if (underWrongLabel(text, shown.line)) continue;

      const needs = requirementFor(shown.argv[0]!, shown.argv[1]);
      const flags = flagsOf(shown.argv);
      const missing = ['profile', 'target'].filter(
        (flag) => needs.includes(flag) && !(flag in flags),
      );

      if (missing.length > 0) {
        incomplete.push(`line ${shown.line}: ${shown.shown} — wants ${missing.map((f) => `--${f}`).join(' ')}`);
      }
    }

    expect(incomplete).toEqual([]);
  });

  test('never tells an agent to print a token', async () => {
    const lines = (await readAsset(asset)).split('\n');

    // `token show --raw` inside a `$(…)` is the correct form and appears in the
    // skill deliberately. `--show` prints the value into the transcript, which
    // is the mistake the skill exists to prevent — so it may appear as the
    // labelled wrong half of a comparison, and nowhere else.
    for (const [index, line] of lines.entries()) {
      if (!line.includes('token show --show')) continue;
      expect(`${lines[index - 1] ?? ''}\n${line}`).toContain('WRONG');
    }
  });
});

describe('the skill and the scout agree', () => {
  test('both state the profile rule, since either may be the only one loaded', async () => {
    for (const asset of ASSETS) {
      expect(await readAsset(asset)).toContain('separate');
    }
  });
});

describe('the skill covers the lifecycle, not only the calls', () => {
  test('names the commands someone runs to own a workspace', async () => {
    // The skill described using an endpoint and registering one, and nothing in
    // between: no deploy, no status, no way to add a profile. An agent asked to
    // deploy read the file, found nothing, and improvised from the CLI's help.
    // Listing them here means the operator half cannot quietly fall out again.
    const asset = ASSETS.find((candidate) => candidate.kind === 'skill')!;
    const named = new Set(commandsNamedIn(await readAsset(asset)));

    const wanted = [
      'deploy',
      'status',
      'sync targets',
      'profile add',
      'profile remove',
      'profile list',
      'target list',
      'doctor',
      'mcp add',
      'mcp list',
    ];

    expect(wanted.filter((command) => !named.has(command))).toEqual([]);
  });
});
