import { defineProvider } from '#connectivity';
import { SLACK_REDACT } from './redact.ts';

/**
 * Slack, through the server Slack runs.
 *
 * The only provider here whose vendor has closed every door but one. Slack's
 * MCP server does not offer Dynamic Client Registration — their documentation
 * says so outright — and a client of your own cannot work either: Slack
 * requires an HTTPS redirect URI, and `connect` listens on `http://127.0.0.1`
 * on a port the kernel picks. There is no proxy, tunnel, or flag that makes a
 * loopback listener HTTPS. A broker would answer it and `defineProvider`
 * refuses one on an mcp connector, because the SDK owns that exchange.
 *
 * What is left is the user token the Slack app mints when you install it, sent
 * as `Authorization: Bearer`. Slack supports that path deliberately; it is the
 * arrangement their own docs describe for a client that cannot register. See
 * ADR-033.
 *
 * Unlike GitHub, this does cost a console visit — creating a Slack app is the
 * only way to get a user token at all, and no amount of implementation work on
 * this side removes it. The setup block is therefore longer than any other here
 * except Google's, and that is the honest shape of it.
 */
export const slack = defineProvider({
  id: 'slack',
  name: 'Slack',
  description: 'Messages, threads, channels, files, and canvases, via Slack\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.slack.com/mcp' },
  auth: { kind: 'bearer' },
  /**
   * The person, not the workspace, and the distinction is load-bearing.
   *
   * `settleIdentity` matches a resolved account against existing connections
   * to decide whether this is a reconnect or a new account. Labelled by
   * workspace, a second person's token in the same workspace would look like a
   * reconnect of the first and overwrite their credential. `auth.test` returns
   * both; `user` is the one that is unique per token.
   *
   * Slack answers a bad token with HTTP 200 and `{ok: false}`, so a wrong token
   * reaches `connect`'s "which account is this?" fallback rather than a clear
   * refusal. Discovery fails loudly one step later, which is where the real
   * error is.
   */
  identity: { kind: 'http', url: 'https://slack.com/api/auth.test', field: 'user' },
  redact: SLACK_REDACT,
  setup: {
    summary:
      'Slack needs an app of its own — there is no personal access token and no way to register ' +
      'automatically, because Slack requires an HTTPS callback and this CLI listens on localhost. ' +
      'You create the app once, install it to your workspace, and paste the user token it mints.',
    docs: 'docs/detailed/setup/slack.md',
    docs_url: 'https://api.slack.com/apps',
    steps: [
      'Open https://api.slack.com/apps and choose "Create New App" → "From scratch". Name it "Lanes Link" and pick the workspace.',
      'Open "OAuth & Permissions" and scroll to "Scopes". Add these under USER TOKEN SCOPES — not Bot Token Scopes; the MCP server reads the user token: search:read.public, search:read.private, search:read.im, search:read.mpim, search:read.users, search:read.files, channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, mpim:read, users:read, chat:write, files:read.',
      'For reactions, canvases, or creating channels, add reactions:write, canvases:read, canvases:write, or channels:write as well. Those tools are listed either way and fail at call time without the scope.',
      'Scroll up and choose "Install to Workspace", then approve. A Slack admin may have to approve it for you.',
      'Copy the "User OAuth Token" from the same page. It starts with xoxp- — not the bot token, which starts with xoxb- and will not work here.',
      'The token does not expire unless you enable token rotation on the app. If you rotate or reinstall, run: lanes link connect slack --replace.',
    ],
    troubleshooting:
      'Slack refused the token. The usual causes are a bot token (xoxb-) pasted where the user token (xoxp-) belongs, ' +
      'a scope missing from USER TOKEN SCOPES, or an app that was reinstalled since — reinstalling mints a new token. ' +
      'Copy the User OAuth Token from https://api.slack.com/apps and re-run: lanes link connect slack --replace.',
    prompts: [
      {
        key: 'token',
        label: 'Slack user OAuth token (xoxp-…)',
        secret: true,
        scope: 'connection' as const,
      },
    ],
  },
});
