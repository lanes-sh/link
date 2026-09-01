import { parseArgv } from '../argv.ts';
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

export async function runAuth(argv: readonly string[]): Promise<void> {
  const { command, flags } = parseArgv(argv);
  const [first] = command;

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
    case 'help':
      console.log(USAGE);
      return;
    default:
      throw new Error(`Unknown: lanes auth ${first}\n\n${USAGE}`);
  }
}
