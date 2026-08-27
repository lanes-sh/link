import { defineProvider } from '#connectivity';
import {
  REDDIT_APP,
  REDDIT_REDIRECT_URI,
  REDDIT_SCOPES,
  REDDIT_USER_AGENT,
  specPath,
} from './oauth.ts';
import { REDDIT_REDACT } from './redact.ts';

/**
 * Reddit, through its own REST API.
 *
 * No MCP server exists to proxy and no OpenAPI document is published, so the
 * spec beside this file is hand-authored — fifteen operations chosen rather
 * than a whole API filtered down. That is a real cost and it buys the thing
 * ADR-008 is about: the operations still become capabilities mechanically, and
 * there is no per-endpoint translation code anywhere in this folder.
 *
 * Reddit was the first provider to need three things the transports did not
 * have — a form-encoded request body, a `User-Agent`, and an OAuth redirect on
 * a port fixed in advance. All three are now general, because each was a gap
 * rather than a Reddit quirk: the last one is the exact reason `../github`
 * gives for using a pasted token instead of OAuth.
 */
export const reddit = defineProvider({
  id: 'reddit',
  name: 'Reddit',
  description:
    'Read subreddits, posts, comments, and search, and post, comment, vote, and edit as your account, via the Reddit API.',
  connector: {
    kind: 'http',
    // Host only. Reddit puts no version in the path, and this must equal the
    // spec's `servers[0].url` — `cli/tools.test.ts` checks that they agree.
    base_url: 'https://oauth.reddit.com',
    openapi: specPath('reddit.v1.json'),
    headers: { 'User-Agent': REDDIT_USER_AGENT },
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: REDDIT_APP,
    /**
     * `www.reddit.com` for the grant, `oauth.reddit.com` for the API. Mixing
     * the two 404s, and the 404 says nothing about which half was wrong.
     */
    authorize_url: 'https://www.reddit.com/api/v1/authorize',
    token_url: 'https://www.reddit.com/api/v1/access_token',
    redirect_uri: REDDIT_REDIRECT_URI,
    scopes: [...REDDIT_SCOPES],
    /**
     * Without `duration=permanent` Reddit returns an access token and no
     * refresh token. The connection then works for exactly one hour and stops,
     * which is a miserable thing to debug an hour after a successful connect —
     * the same failure `authorize_params` was added for, where Google needs
     * `access_type=offline`.
     */
    authorize_params: { duration: 'permanent' },
    revoke_url: 'https://www.reddit.com/api/v1/revoke_token',
  },
  identity: { kind: 'http', url: 'https://oauth.reddit.com/api/v1/me', field: 'name' },
  redact: REDDIT_REDACT,
  /**
   * Said once here rather than left for the tool descriptions to imply.
   *
   * Both are things an agent gets wrong on the first attempt and cannot learn
   * from the error: Reddit answers a bare id with a generic failure, and a
   * subreddit that requires a flair rejects the submission without saying that
   * a flair was what was missing.
   */
  hints: {
    add_comment:
      'thing_id must be a fullname — t3_<id> for a post, t1_<id> for a comment — not the bare id that appears in a URL.',
    submit_post:
      'Many subreddits reject a submission with no flair. Call list_flairs first and pass flair_id, and read get_rules when posting somewhere unfamiliar.',
  },
  setup: {
    summary:
      'Reddit needs an app of your own, which takes a couple of minutes in a browser. There is no shared ' +
      'client for this one on purpose: Reddit rate-limits per client id, so a client everyone shared would ' +
      'mean strangers using up your hundred requests a minute. Your own app gets its own budget.',
    docs: 'docs/detailed/setup/reddit.md',
    docs_url: 'https://www.reddit.com/prefs/apps',
    steps: [
      'Open https://www.reddit.com/prefs/apps and choose "create another app...".',
      'Name it something you will recognise later — the name is how you revoke this one without touching your others.',
      'Choose "web app". "script" only ever reaches your own account, and "installed app" has no secret for this to hold.',
      `Set the redirect uri to exactly ${REDDIT_REDIRECT_URI} — Reddit matches it character for character, and this is the address this command listens on.`,
      'Create the app. The client id is the string under the app name; the secret is the field labelled "secret".',
      'Reddit also asks you to register for API access separately, from the link on that page. Creating the app is not the same as being allowed to call the API.',
      'If you regenerate the secret later, run: lanes link connect reddit --replace.',
    ],
    troubleshooting:
      'Reddit refused the connection. If the browser said "invalid redirect_uri", the value registered on the app ' +
      `is not exactly ${REDDIT_REDIRECT_URI}. If the call failed after connecting, the app exists but API access ` +
      'has not been granted — that is a separate registration, linked from https://www.reddit.com/prefs/apps. ' +
      'A 429 means the hundred-per-minute limit for this client id was reached.',
    prompts: [
      {
        key: 'client_id',
        label: 'Reddit client ID',
        secret: false,
        credential_ref: `${REDDIT_APP}/client_id`,
      },
      {
        key: 'client_secret',
        label: 'Reddit client secret',
        secret: true,
        credential_ref: `${REDDIT_APP}/client_secret`,
      },
    ],
  },
});
