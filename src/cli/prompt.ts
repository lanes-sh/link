import { createInterface } from 'node:readline';
import { paint, style } from './terminal.ts';

/**
 * Interactive input.
 *
 * Secrets are read without echoing. That is not theatre: a client secret typed
 * into a terminal ends up in scrollback, in a screen recording, and in whatever
 * the terminal emulator persists between sessions.
 */

export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptCancelled';
  }
}

/**
 * Whether there is anyone to answer.
 *
 * Exported so a command can *decide* rather than discover: `deploy` asks its
 * setup questions every run, which is only the right default when a person is
 * there. Piped into a script, the same run has to fall back to what the config
 * already says instead of throwing at the first prompt.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

function assertInteractive(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      'This command needs an interactive terminal to collect credentials. ' +
        'For scripted setup, write the credentials to the store first and re-run.',
    );
  }
}

/**
 * The chrome around every question, in one place so the three cannot drift.
 *
 * A marker, the question, and a caret. The marker is what separates a question
 * from the block above it — a prompt with no chrome at the end of a seven-step
 * walkthrough reads as an eighth step, which is what it looked like before.
 *
 * The trailing `: ` this replaces was appended here *and* by five call sites,
 * so `Display name [foo]: ` came out as `Display name [foo]: : `. That the
 * double colon survived is the argument for the punctuation living in one
 * place rather than at every question.
 *
 * A question may carry lines before its last one — a variable's description is
 * a sentence nobody can guess, and `Prompter.ask` takes one string. Those go
 * out as narration and only the final line is decorated, so the caret stays
 * where the cursor is.
 */
export function chrome(question: string): { readonly lead: readonly string[]; readonly prompt: string } {
  const lines = question.trim().split('\n');
  const last = lines.pop() ?? '';

  return {
    lead: lines.map((line) => line.trim()),
    prompt: `${paint.accent('?')} ${last.trim()} ${paint.muted('\u203a')} `,
  };
}

export async function ask(question: string): Promise<string> {
  assertInteractive();

  const { lead, prompt } = chrome(question);
  for (const line of lead) process.stderr.write(`${line}\n`);

  // stderr, not stdout. `--json` is universal (`selection.ts`), nothing stops an
  // interactive `connect --json`, and readline wrote its question into the
  // middle of the document. `connect/custom/ask.ts` had already reached this
  // conclusion and applied it to its own prompts only.
  //
  // `terminal` is set rather than inferred from `output.isTTY`, so redirecting
  // stderr alone cannot silently take line editing away from someone typing.
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      rl.question(prompt, resolve);
      rl.once('SIGINT', () => reject(new PromptCancelled()));
    });
    return answer.trim();
  } finally {
    rl.close();
    // `close()` releases the interface but leaves stdin resumed and referenced,
    // which keeps the event loop alive: the command finishes, prints, and then
    // sits there until Ctrl-C. `askSecret` already pauses; this is the same
    // cleanup for the same reason.
    process.stdin.pause();
  }
}

/**
 * Read a line without echoing it.
 *
 * Raw mode rather than a muted writable stream: muting the output still lets
 * the terminal's own line editing echo, which defeats the point on some
 * emulators. Reading keystrokes directly is the only way to be sure nothing
 * reaches the screen.
 */
export async function askSecret(question: string): Promise<string> {
  assertInteractive();

  const { lead, prompt } = chrome(question);
  for (const line of lead) process.stderr.write(`${line}\n`);
  process.stderr.write(prompt);

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        switch (char) {
          case '\r':
          case '\n':
            cleanup();
            resolve(value.trim());
            return;
          case '': // Ctrl-C
            cleanup();
            reject(new PromptCancelled());
            return;
          case '': // backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters rather than storing them.
            if (char >= ' ') value += char;
        }
      }
    };

    stdin.on('data', onData);
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = await ask(`${question} ${style.dim(defaultYes ? '[Y/n]' : '[y/N]')}`);
  if (answer.length === 0) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

/**
 * Where a command collects an answer from.
 *
 * The same seam as `EndpointReporter`, for the same reason: `connect` had one
 * caller, a terminal, and the terminal was reached directly. An agent driving
 * the CLI is a second caller, and it cannot answer a prompt — so the choice of
 * where answers come from has to be the caller's rather than a module-level
 * import of `process.stdin`.
 *
 * `interactive` is on the interface rather than inferred by callers, because
 * the useful refusal message differs per question. A missing credential points
 * at `secrets set`; a broad scope points at `--accept-broad-scopes`. Only the
 * caller knows which, and a prompter that threw a generic error would bury it.
 */
export interface Prompter {
  readonly interactive: boolean;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
}

/** Today's behaviour: a real terminal, refusing when there is not one. */
export const terminalPrompter: Prompter = {
  interactive: true,
  ask,
  askSecret,
  confirm,
};

/**
 * A prompter that answers nothing, and says what to do instead.
 *
 * It deliberately does not read flags, environment variables, or a file. A
 * credential passed as an argument is in the shell history, in `ps` output
 * while the process runs, and in any transcript of the session — which is why
 * `secrets set` already refuses argv and reads stdin. Adding a second, weaker
 * path here would contradict that rule one directory away, and an agent-typed
 * flag lands in a transcript too.
 *
 * Reaching this at all means the preflight missed something: a non-interactive
 * `connect` resolves every declared value before it starts. So the message
 * names the command that lists them rather than guessing at the one value.
 */
export function nonInteractivePrompter(planCommand: string): Prompter {
  const refuse = (question: string): never => {
    throw new Error(
      `Cannot ask for "${question.trim()}" — this run is non-interactive.\n` +
        `  Store what this provider needs first, then re-run. To list it:\n` +
        `    ${planCommand}`,
    );
  };

  return {
    interactive: false,
    ask: async (question) => refuse(question),
    askSecret: async (question) => refuse(question),
    confirm: async (question) => refuse(question),
  };
}
