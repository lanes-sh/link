import { describe, expect, test } from 'bun:test';
import { nonInteractivePrompter, terminalPrompter } from './prompt.ts';

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
