import { defineProvider } from '#connectivity';
import { SLACK_REDACT } from './redact.ts';
import { SLACK_APP, SLACK_BROKER, SLACK_SCOPES } from './oauth.ts';

/**
 * Slack, through the server Slack runs.
 *
 * Slack does not offer Dynamic Client Registration and is not going to: it
 * would let a client authenticate a user without an app existing, and on
 * Enterprise Grid an admin approves each app first. So a client has to be
 * pre-registered — and the question this provider used to answer wrongly is
 * *whose*.
 *
 * It was the operator's: create an app, transcribe sixteen user-token scopes,
 * install it, paste the `xoxp-` it mints. That was the honest shape of it only
 * while the alternative was believed impossible. It was not. Every client that
 * reaches Slack without a console visit does the same thing — registers one app
 * and ships its id — and this now does too, with the secret behind the broker
 * ADR-028 already built for Google and the redirect on a port Slack has been
 * told about. ADR-040 records what changed and why the reasoning in ADR-033 no
 * longer holds.
 *
 * The paste is still here, behind `--auth pasted_token`. A workspace whose admin has not
 * approved the Lanes app cannot use the flow above, and that is not a decision
 * the person running this command can make.
 */
export const slack = defineProvider({
  id: 'slack',
  name: 'Slack',
  description: 'Messages, threads, channels, files, and canvases, via Slack\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.slack.com/mcp' },
  /**
   * An mcp connector that names its own endpoints, which is what takes it off
   * the SDK's flow and onto the one this repository drives.
   *
   * Not an override of discovery for its own sake — Slack publishes perfectly
   * good metadata at `/.well-known/oauth-authorization-server` and these two
   * values are copied from it. It is that the SDK ends its flow by posting to
   * the token endpoint with the client *it* holds, and the client here is held
   * by a broker. Declaring the endpoints is how a manifest says the exchange is
   * ours to route. See `defineProvider` and ADR-040.
   */
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: SLACK_APP,
    authorize_url: 'https://slack.com/oauth/v2_user/authorize',
    token_url: 'https://slack.com/api/oauth.v2.user.access',
    scopes: [...SLACK_SCOPES],
    broker: SLACK_BROKER,
    /**
     * Slack returns no refresh token, and that is the successful answer.
     *
     * A user token is long-lived unless token rotation is enabled on the app.
     * Demanding one here would refuse every connection that worked — the
     * default exists for Google, where a missing refresh token means the grant
     * already existed and the connection would die in an hour.
     */
    refresh_token: 'optional',
  },
  /**
   * The person *and* the workspace, because either alone collides.
   *
   * `settleIdentity` matches a resolved account against existing connections to
   * decide whether this is a reconnect or a new account, so the string has to
   * be unique per credential. Neither half of `auth.test` is:
   *
   *   - `team` alone — two people in one workspace look like one account, and
   *     the second connect overwrites the first's token.
   *   - `user` alone — Slack's "user" is a workspace-scoped handle, so one
   *     person in two workspaces looks like a reconnect and the second
   *     workspace overwrites the first. Connecting more than one workspace is
   *     the ordinary case here, which made this the more likely of the two.
   *
   * Together they are unique, and `alice (Acme)` is a row somebody can read.
   *
   * Slack answers a bad token with HTTP 200 and `{ok: false}`, so a wrong token
   * reaches `connect`'s "which account is this?" fallback rather than a clear
   * refusal. Discovery fails loudly one step later, which is where the real
   * error is.
   */
  identity: {
    kind: 'http',
    url: 'https://slack.com/api/auth.test',
    field: 'user',
    qualifier: 'team',
  },
  redact: SLACK_REDACT,
  /**
   * Read only by `--auth pasted_token`. The browser route asks for nothing.
   *
   * `connection` scope rather than `shared` is what makes `--own-client` refuse
   * with "no bring-your-own client path", which is true: this asks for a token,
   * never for a client of the operator's to register.
   */
  setup: {
    summary:
      'Slack normally needs nothing set up — one browser round trip against the app Lanes ' +
      'registered. Pasting a token is the way past a workspace whose admin has not approved ' +
      'that app, using one from an app the workspace already trusts.',
    docs: 'docs/detailed/setup/slack.md',
    docs_url: 'https://api.slack.com/apps',
    steps: [
      'Open https://api.slack.com/apps and choose "Create New App" → "From scratch". Name it and pick the workspace.',
      'Open "OAuth & Permissions" and add the scopes you need under USER TOKEN SCOPES — not Bot Token Scopes; the MCP server reads the user token. The full set this provider asks for in the browser is listed in docs/detailed/setup/slack.md.',
      'Choose "Install to Workspace" and approve. A Slack admin may have to approve it for you.',
      'Copy the "User OAuth Token". It starts with xoxp- — not the bot token, which starts with xoxb- and will not work here.',
      'The token does not expire unless you enable token rotation on the app. If you rotate or reinstall, run: lanes link connect slack --profile personal --target local --auth pasted_token --replace.',
    ],
    troubleshooting:
      'Slack refused the token. The usual causes are a bot token (xoxb-) pasted where the user token (xoxp-) belongs, ' +
      'a scope missing from USER TOKEN SCOPES, or an app that was reinstalled since — reinstalling mints a new token. ' +
      'Copy the User OAuth Token from https://api.slack.com/apps and re-run: lanes link connect slack --profile personal --target local --auth pasted_token --replace.',
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
