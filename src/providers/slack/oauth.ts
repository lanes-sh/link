import type { AuthBroker } from '#connectivity';
import { brokerOriginOverride } from '#connectivity/auth/index.ts';

/**
 * Where Slack's client comes from, and why it cannot come from here.
 *
 * Slack refuses Dynamic Client Registration and says so in its documentation.
 * That is not an omission waiting to be filled: DCR would let a client
 * authenticate a user without an app existing, and on Enterprise Grid an admin
 * approves each app before it can authenticate anyone. Waiting for it is
 * waiting for something that is not coming.
 *
 * So somebody has to be pre-registered. Until now that somebody was the
 * operator, once per person, in a browser tab, transcribing sixteen scopes. It
 * is this project instead now — one app, registered once, exactly the
 * arrangement every other client that connects to Slack without a console visit
 * uses. See ADR-040.
 */
export const SLACK_APP = 'slack';

const BROKER_ORIGIN = 'https://api.lanes.sh';
const BROKER_PATH = '/v1/auth/link/slack';

/**
 * The client Lanes operates, reached at an origin an override can move.
 *
 * Same shape as Google's and for the same reasons — see
 * `../google/shared/oauth.ts`. What differs is what a broker outage costs.
 * Slack issues a long-lived user token and no refresh token unless token
 * rotation is switched on for the app, so this is consulted at `connect` and
 * never again: an outage here cannot interrupt an agent mid-request the way
 * ADR-028 warned a shared dependency can. That is the whole of why the fallback
 * below is a reasonable second answer rather than a necessary one.
 */
export function slackBroker(env?: Record<string, string | undefined>): AuthBroker {
  return {
    url: `${brokerOriginOverride(env) ?? BROKER_ORIGIN}${BROKER_PATH}`,
    operator: 'Lanes',
    docs_url: 'https://lanes.sh/link#slack',
  };
}

export const SLACK_BROKER: AuthBroker = slackBroker();

/**
 * Where Slack sends the browser back — and why it is not this machine.
 *
 * Slack refuses to register a Redirect URL that is not HTTPS. Verified against
 * a real app: the field rejects `http://localhost:<port>/callback` outright, so
 * a loopback listener cannot be named to Slack at all. A CLI cannot be HTTPS
 * either — there is no certificate for 127.0.0.1 a browser will accept.
 *
 * So the redirect goes to the broker, which bounces it straight down to the
 * listener `connect` opened, carrying the port in `state`. The URL itself is
 * not written here: `/config` publishes it, because which one is correct
 * depends on which deployment answered, and a broker running on loopback for a
 * test would otherwise need its own spelling of it.
 *
 * The cost is that Slack cannot be connected without the broker. Google's is
 * optional — a profile may register its own client and never call it — and
 * Slack's is not, because the broker *is* the HTTPS origin. Recorded in
 * ADR-040, and softened by Slack issuing no refresh token: an outage stops
 * `connect`, never a connection already made.
 */

/**
 * What the browser grant asks for.
 *
 * These are user-token scopes: Slack's MCP server reads the user token, and a
 * bot token is a different credential that does not work there at all. The list
 * is what the setup page used to ask the operator to transcribe by hand, moved
 * to where it can be shown before consent instead — which is what restores the
 * scope-disclosure gate ADR-033 recorded as permanently absent for Slack.
 *
 * The last four are what `reactions`, `canvases`, and channel creation need.
 * They are requested rather than left out because the tools appear in the list
 * either way and fail at call time without them, and a tool that is visible and
 * always fails is worse than a scope on the consent screen. What an agent may
 * actually call is bounded by policy, where `connect` grants read and nothing
 * else by default.
 */
export const SLACK_SCOPES = [
  'search:read.public',
  'search:read.private',
  'search:read.im',
  'search:read.mpim',
  'search:read.users',
  'search:read.files',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'mpim:read',
  'users:read',
  'chat:write',
  'files:read',
  'reactions:write',
  'canvases:read',
  'canvases:write',
  'channels:write',
] as const;
