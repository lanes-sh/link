#!/usr/bin/env bun
import { ConfigError } from '#profile';
import { run as runLink } from './main.ts';
import { print, printErr, style } from './output.ts';

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
  link: 'a self-hosted MCP gateway for your accounts, memory, skills, and secrets',
};

function areasUsage(): string {
  const rows = Object.entries(AREAS)
    .map(([name, blurb]) => `  ${style.bold(`lanes ${name}`)}  ${blurb}`)
    .join('\n');

  return `${style.bold('lanes')} — your own tools, wherever you work\n\n${rows}\n\nRun ${style.bold('lanes <area> help')} for what an area can do.\n`;
}

async function main(argv: readonly string[]): Promise<void> {
  const [area, ...rest] = argv;

  // Bare `lanes`, or asking for help before naming an area: list what exists.
  // Not an error — someone who typed `lanes` wants to know what it offers.
  if (!area || area === 'help' || area === '--help') {
    print(areasUsage());
    return;
  }

  if (area === 'link') return runLink(rest);

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
