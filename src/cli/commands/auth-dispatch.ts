import { parseArgv } from '../argv.ts';
import { refuseUnknownFlags } from '../unknown-flags.ts';
import { authLogin, authLogout, authStatus, authWorkspaces } from './auth.ts';

/**
 * `lanes auth <command>` — the grammar, and nothing else.
 *
 * Its own file for the reason `main.ts` is one: a dispatcher that also does the
 * work is a file that grows a case at a time until nobody can see the grammar.
 * Four commands, one line each.
 */

const USAGE = `lanes auth — who this machine is signed in as

  lanes auth login        sign in, in a browser
  lanes auth logout       forget this machine's session
  lanes auth status       who you are, and how long the token lasts
  lanes auth workspaces   the Lanes workspaces you are a member of

  --json                  the same answer, as a document
  --api-url <url>         a self-hosted API, instead of the default
`;

/**
 * Every flag this area reads, written out rather than derived.
 *
 * `selection.ts` builds its allowlist from the tables that say what a `link`
 * command must be told. Nothing here needs a profile or a workspace, so there is
 * no table to derive from and three names is the whole of it.
 */
const ACCEPTED = new Set(['help', 'json', 'api-url']);

export async function runAuth(argv: readonly string[]): Promise<void> {
  const { command, flags } = parseArgv(argv);
  const [first] = command;

  // Before anything reads a flag, and the reason is `--api-url`: misspelled, it
  // was dropped and the sign-in went to the default broker instead of the one
  // named, which nothing on the success path prints. See `../unknown-flags.ts`.
  refuseUnknownFlags(`lanes auth${first === undefined ? '' : ` ${first}`}`, ACCEPTED, flags);

  // `--help` as well as `help`. Allowing the flag through without answering it
  // would be the same defect the line above exists to stop: it was accepted and
  // ignored, so `lanes auth --help` printed the status instead of the usage.
  if (first === 'help' || flags['help'] === true) {
    console.log(USAGE);
    return;
  }

  const options = {
    json: flags['json'] === true,
    ...(typeof flags['api-url'] === 'string' ? { apiUrl: flags['api-url'] } : {}),
  };

  switch (first) {
    case 'login':
      return authLogin(options);
    case 'logout':
      return authLogout(options);
    case 'status':
    case undefined:
      return authStatus(options);
    case 'workspaces':
      return authWorkspaces(options);
    default:
      throw new Error(`Unknown: lanes auth ${first}\n\n${USAGE}`);
  }
}
