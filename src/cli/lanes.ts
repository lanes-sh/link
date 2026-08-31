#!/usr/bin/env bun
import { ConfigError } from '#profile';
import { print, printErr, style } from './output.ts';
import { version } from './version.ts';

/**
 * `lanes` — the command, and the one area it currently has.
 *
 * The grammar is `lanes <area> <command>`, and `link` is the only area today.
 * It is a level of indirection that buys nothing yet, which is the point: the
 * alternative was a second top-level binary the first time Lanes grew another
 * capability, and by then every doc, every shell alias, and every agent
 * registration would already say `lanes-link`.
 *
 * Adding an area is one entry in AREAS and one case below. Areas own their own
 * argv completely — this file peels one token and hands over the rest, so
 * `lanes link status` and a future `lanes <other> status` never collide.
 */

const AREAS: Record<string, string> = {
  link: 'a self-hostable MCP gateway for all your connections, memory, tasks, files, and secrets',
};

/** Commands that belong to the binary rather than to any one area. */
const TOP_LEVEL: Record<string, string> = {
  auth: 'sign in to Lanes, so a profile can say who may use it',
  'set-workspace': 'which workspace a command means when it does not say',
};

function areasUsage(): string {
  const rows = Object.entries(AREAS)
    .map(([name, blurb]) => `  ${style.bold(`lanes ${name}`)}  ${blurb}`)
    .join('\n');

  const top = Object.entries(TOP_LEVEL)
    .map(([name, blurb]) => `  ${style.bold(`lanes ${name}`)}  ${blurb}`)
    .join('\n');

  return (
    `${style.bold('lanes')} — your own tools, wherever you work\n\n${rows}\n\n${top}\n\n` +
    `Run ${style.bold('lanes <area> help')} for what an area can do, ` +
    `or ${style.bold('lanes --version')} for which release this is.\n`
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const [area, ...rest] = argv;

  // Bare `lanes`, or asking for help before naming an area: list what exists.
  // Not an error — someone who typed `lanes` wants to know what it offers.
  if (!area || area === 'help' || area === '--help') {
    print(areasUsage());
    return;
  }

  // Before the area is peeled, because it belongs to the binary rather than to
  // any one area — and because `lanes --version` is the reflex for anything on
  // a PATH. `lanes link version` answers with the same string.
  if (area === '--version' || area === '-v') {
    print(version());
    return;
  }

  // A top-level command rather than an area, because it selects the workspace
  // *the CLI* acts in — every area's commands read the same answer (ADR-061).
  if (area === 'auth') {
    const { runAuth } = await import('./commands/auth-dispatch.ts');
    return await runAuth(rest);
  }

  if (area === 'set-workspace') {
    const { setWorkspace } = await import('./commands/set-workspace.ts');
    const { parseArgv } = await import('./argv.ts');
    const { command, flags } = parseArgv(rest);
    return await setWorkspace(command[0], { json: flags['json'] === true });
  }

  if (area === 'link') {
    // Loaded here rather than at the top of the file so that a failure while
    // the area's module graph evaluates — a malformed environment variable read
    // at import time, say — is caught below and printed as an `error` line. A
    // static import throws before this file's try block is reached, and Bun
    // renders that as a stack trace with the message buried in it.
    const { run: runLink } = await import('./main.ts');
    return await runLink(rest);
  }

  throw new Error(
    `Unknown area "${area}". Available: ${Object.keys(AREAS).join(', ')}.\n` +
      `  Did you mean: lanes link ${area}?`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  // A ConfigError already names the exact path and what to do about it, so it
  // is printed as-is rather than wrapped in a generic failure message.
  const message = error instanceof ConfigError ? error.message : (error as Error).message;
  printErr(`${style.red('error')}  ${message}`);
  process.exit(1);
}
