import { describe, expect, test } from 'bun:test';
import { chrome, nonInteractivePrompter, terminalPrompter } from './prompt.ts';
import { stripAnsi } from './typeset.ts';

/**
 * Where a command collects an answer from.
 *
 * Two properties, and both are about what happens when there is nobody to ask.
 * The terminal prompter must keep refusing a non-TTY in the wording operators
 * have already learned, and the non-interactive one must refuse in a way that
 * says what to do instead — a prompter that threw "not a TTY" at an agent would
 * be exactly the dead end this replaced.
 */

describe('nonInteractivePrompter', () => {
  const prompter = nonInteractivePrompter('lanes link setup plan thing --profile personal');

  test('refuses every question, naming the command that lists what is needed', async () => {
    for (const askSomething of [
      () => prompter.ask('Which account is this?'),
      () => prompter.askSecret('  App password'),
      () => prompter.confirm('Authorise with these scopes?'),
    ]) {
      expect(askSomething()).rejects.toThrow(/non-interactive/);
      expect(askSomething()).rejects.toThrow(/lanes link setup plan thing --profile personal/);
    }
  });

  test('the refusal quotes the question, so it is clear what went unanswered', async () => {
    expect(prompter.askSecret('  App password')).rejects.toThrow(/"App password"/);
  });

  test('declares itself non-interactive, which is how callers pick their message', () => {
    // The useful refusal differs per question — a missing credential points at
    // `secrets set`, a broad scope at `--accept-broad-scopes` — and only the
    // caller knows which. A prompter that threw a generic error would bury it.
    expect(prompter.interactive).toBe(false);
    expect(terminalPrompter.interactive).toBe(true);
  });
});

describe('terminalPrompter', () => {
  test('still refuses a non-TTY in the wording it always used', async () => {
    // A regression guard on a message rather than on behaviour: `connect`'s old
    // error is what operators have in their scrollback and in search results,
    // and it already points at the right fix.
    if (process.stdin.isTTY) return;

    expect(terminalPrompter.ask('Which account is this?')).rejects.toThrow(
      /needs an interactive terminal to collect credentials/,
    );
    expect(terminalPrompter.askSecret('  App password')).rejects.toThrow(
      /write the credentials to the store first and re-run/,
    );
  });
});

describe('the chrome around a question', () => {
  test('carries a marker and a caret, so a prompt is not read as another step', () => {
    // The block above a prompt ends in seven numbered steps. Without a marker
    // the question was an eighth.
    const { prompt } = chrome('GitHub personal access token');

    expect(stripAnsi(prompt)).toBe('? GitHub personal access token › ');
  });

  test('does not double the punctuation five call sites used to append', () => {
    // `ask` added `: ` and so did the call site, so this came out as
    // `Display name [foo]: : `. It shipped, which is the argument for the
    // punctuation living here rather than at every question.
    expect(stripAnsi(chrome('Display name [foo]').prompt)).not.toContain(':');
  });

  test('an indent a call site no longer needs is absorbed rather than shown', () => {
    // The thirteen sites that indented their own questions are swept in this
    // change; trimming here is what stops a missed one rendering as `?   Foo`.
    expect(stripAnsi(chrome('  Region').prompt)).toBe('? Region › ');
  });

  test('everything before the last line is narration, not part of the question', () => {
    // A variable's description is a sentence nobody can guess, and `ask` takes
    // one string. Decorating the whole thing would put the caret two lines
    // above the cursor.
    const { lead, prompt } = chrome('Where the server lives.\nHostname [example.com]');

    expect(lead).toEqual(['Where the server lives.']);
    expect(stripAnsi(prompt)).toBe('? Hostname [example.com] › ');
  });
});
