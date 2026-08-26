import { describe, expect, test } from 'bun:test';
import { slack } from './index.ts';
import { SLACK_SCOPES, slackBroker } from './oauth.ts';

/**
 * What has to stay true for Slack to connect without a console visit.
 *
 * Each of these was a sentence in ADR-033 explaining why it could not be done,
 * so each is worth a test rather than a comment: the reasoning that produced
 * the old shape was sound about Slack and wrong about this repository, and
 * nothing here should quietly drift back.
 */
describe('slackBroker', () => {
  test('points at the client Lanes operates when nothing overrides it', () => {
    expect(slackBroker({}).url).toBe('https://api.lanes.sh/v1/auth/link/slack');
  });

  test('moves the origin and keeps the path', () => {
    expect(slackBroker({ LANES_LINK_BROKER_ORIGIN: 'http://127.0.0.1:8080' }).url).toBe(
      'http://127.0.0.1:8080/v1/auth/link/slack',
    );
  });
});

describe('the manifest', () => {
  const auth = slack.auth.kind === 'oauth' ? slack.auth : undefined;

  test('names its own endpoints, which is what takes it off the SDK flow', () => {
    // An mcp connector hands the exchange to the SDK unless it declares these,
    // and the SDK cannot post to a token endpoint with a client a broker holds.
    // Declaring both is the seam. See ADR-040.
    expect(slack.connector.kind).toBe('mcp');
    expect(auth?.authorize_url).toBe('https://slack.com/oauth/v2_user/authorize');
    expect(auth?.token_url).toBe('https://slack.com/api/oauth.v2.user.access');
  });

  test('expects no refresh token, because a Slack user token is long-lived', () => {
    // The default is `required`, which is Google's reading. Demanding one here
    // would refuse every Slack connection that worked.
    expect(auth?.refresh_token).toBe('optional');
  });

  test('names no redirect of its own, because Slack will not take a loopback one', () => {
    // Verified against a real app: the Redirect URL field rejects a non-HTTPS
    // value, so the listener cannot be named to Slack at all. The broker
    // receives the callback and bounces it down, and publishes the URL through
    // `/config` rather than the manifest writing it down twice.
    expect(auth).not.toHaveProperty('redirect');
    expect(auth?.broker?.url).toContain('/v1/auth/link/slack');
  });

  test('declares no client of its own, because the broker is not optional here', () => {
    // Google's broker can be skipped by a profile that registers its own
    // client. Slack's cannot: the broker *is* the HTTPS origin the redirect
    // needs, so there is no arrangement that completes without it.
    expect(auth).not.toHaveProperty('client_id');
  });

  test('asks for user-token scopes in the browser rather than on a setup page', () => {
    // Sixteen of these used to be a numbered step telling the operator to type
    // them into a console. Requesting them is what lets `confirmScopes` show
    // them first — the gate ADR-033 recorded as permanently absent for Slack.
    expect(auth?.scopes).toEqual([...SLACK_SCOPES]);
    expect(auth?.scopes).toContain('search:read.public');
    expect(auth?.scopes).toContain('chat:write');
  });

  test('keeps a pasted token as the way past a workspace that has not approved us', () => {
    // Enterprise Grid requires an admin to approve an app before it can
    // authenticate anyone, and that is not the operator's decision to make.
    const prompts = slack.setup?.prompts ?? [];
    expect(prompts.map((prompt) => prompt.key)).toEqual(['token']);
    expect(prompts[0]?.scope).toBe('connection');
    expect(prompts[0]?.secret).toBe(true);
  });

  test('has no bring-your-own-client path, and says so by asking for no client', () => {
    // `--own-client` refuses on the absence of a `shared` prompt. Slack asks
    // for a token, never for a client id and secret of the operator's.
    expect(promptsOfScope('shared')).toEqual([]);
  });
});

function promptsOfScope(scope: string): string[] {
  return (slack.setup?.prompts ?? []).filter((p) => p.scope === scope).map((p) => p.key);
}
