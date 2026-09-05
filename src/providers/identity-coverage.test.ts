import { describe, expect, test } from 'bun:test';
import { PROVIDER_MANIFESTS } from './index.ts';

/**
 * Every provider can say whose account it is, or says why it cannot.
 *
 * `connect` resolves an identity from the manifest's `identity` block, then
 * from the authorization server (`cli/introspection.ts`), and only then asks
 * the operator. The prompt is the fallback and its own doc comment calls it
 * one — but 75 of 105 manifests declared nothing, so for most of the catalogue
 * it was the *only* path, and connecting meant typing your own address a second
 * after authorising.
 *
 * The number will not come down on its own, and worse, it silently goes back up:
 * a provider is fifteen lines of data, adding one costs nothing, and nothing
 * about writing those fifteen lines raises the question. So the build raises it.
 * A new provider either declares an identity block, authenticates to nothing, or
 * is listed below with the reason — and the list is checked in both directions,
 * so an entry cannot outlive the gap it records.
 *
 * **This is a ledger, not an allowlist.** Entries are meant to leave it.
 */

/**
 * The sweep that has not happened yet, and what makes it slow.
 *
 * These are the hosted-MCP providers. Their tool lists are not published in a
 * form that can be read here — every one of the servers refuses an
 * unauthenticated `tools/list` with a 401 — so the identity call has to come
 * from vendor documentation, one vendor at a time, and each block ships
 * unverified until somebody with an account on that vendor connects.
 *
 * Neither generic route covers them: of the 80 MCP endpoints this repository
 * names, five advertise RFC 7662 introspection and three advertise OIDC
 * userinfo. That measurement is why the per-vendor work is the substance and
 * the generic probe is the cheap part.
 */
const UNSWEPT =
  'Hosted MCP server, not yet swept: `tools/list` is refused unauthenticated, so the identity call has to come from vendor documentation.';

const NO_IDENTITY: Readonly<Record<string, string>> = {
  discord: 'Decided, not omitted, and written out in the provider: the stored credential is `Bot MTIz…`, so a bearer probe would send `Bearer Bot MTIz…` and earn a 401 on every connect.',
  google_tasks: 'Decided, not omitted, and written out in the provider: nothing reachable under `auth/tasks` returns an address, and `userinfo.email` is a scope this provider has no other use for.',
  bunq: 'Not swept. bunq authenticates through its own handshake rather than OAuth, so neither generic route applies, and its `/v1/user` shape has not been checked against what the strategy stores.',
  stripe: UNSWEPT,
  sentry: UNSWEPT,
  supabase:
    'Verified, not unswept: `GET /v1/profile` refuses an OAuth token ("does not support oauth access yet"), there is no userinfo, `/v1/user` or `/v1/me`, and what OAuth does reach — organizations, projects — is a collection.',
  figma: UNSWEPT,
  canva: UNSWEPT,
  dropbox: UNSWEPT,
  todoist: UNSWEPT,
  clickup: UNSWEPT,
  monday: UNSWEPT,
  airtable: UNSWEPT,
  miro: UNSWEPT,
  calendly: UNSWEPT,
  close: UNSWEPT,
  zapier: UNSWEPT,
  paypal: UNSWEPT,
  square: UNSWEPT,
  mercury: UNSWEPT,
  vercel: UNSWEPT,
  netlify: UNSWEPT,
  neon: UNSWEPT,
  prisma: UNSWEPT,
  sanity: UNSWEPT,
  webflow: UNSWEPT,
  wix: UNSWEPT,
  datadog: UNSWEPT,
  grafana: UNSWEPT,
  fireflies: UNSWEPT,
  gamma: UNSWEPT,
  jam: UNSWEPT,
  cloudflare_observability: UNSWEPT,
  cloudflare_bindings: UNSWEPT,
  atlassian: UNSWEPT,
  hubspot: UNSWEPT,
  render: UNSWEPT,
  algolia: UNSWEPT,
  amplitude: UNSWEPT,
  apify: UNSWEPT,
  attio: UNSWEPT,
  betterstack: UNSWEPT,
  brightdata: UNSWEPT,
  buildkite: UNSWEPT,
  circleci: UNSWEPT,
  contentful: UNSWEPT,
  expensify: UNSWEPT,
  flagsmith: UNSWEPT,
  heroku: UNSWEPT,
  hygraph: UNSWEPT,
  insightly: UNSWEPT,
  klaviyo: UNSWEPT,
  mixpanel: UNSWEPT,
  mux: UNSWEPT,
  navan: UNSWEPT,
  paddle: UNSWEPT,
  posthog: UNSWEPT,
  ramp: UNSWEPT,
  recurly: UNSWEPT,
  remote: UNSWEPT,
  replicate: UNSWEPT,
  resend: UNSWEPT,
  riverside: UNSWEPT,
  rootly: UNSWEPT,
  rudderstack: UNSWEPT,
  salesloft: UNSWEPT,
  shortcut: UNSWEPT,
  storyblok: UNSWEPT,
  tavily: UNSWEPT,
  vimeo: UNSWEPT,
  whimsical: UNSWEPT,
  workable: UNSWEPT,
};

describe('identity coverage', () => {
  const asks = PROVIDER_MANIFESTS.filter(
    (manifest) => !manifest.identity && manifest.auth.kind !== 'none',
  );

  test('a provider that will ask the operator is one that said why it has to', () => {
    // The owner layer is exempt without being listed: `auth.kind === 'none'`
    // takes the `unaccounted` branch in `settleIdentity` and is named after its
    // provider, so it never reaches the question.
    const unexplained = asks.map((manifest) => manifest.id).filter((id) => !NO_IDENTITY[id]);

    expect(unexplained).toEqual([]);
  });

  test('and an entry does not outlive the gap it records', () => {
    // The half that makes this a ledger. Without it, a provider that gained an
    // identity block would keep its excuse, and the list would stop meaning
    // anything long before it stopped being read.
    const stale = Object.keys(NO_IDENTITY).filter(
      (id) => !asks.some((manifest) => manifest.id === id),
    );

    expect(stale).toEqual([]);
  });

  test('every reason is a reason, not a word typed to quiet the check', () => {
    for (const [id, reason] of Object.entries(NO_IDENTITY)) {
      expect(`${id}: ${reason}`.length).toBeGreaterThan(60);
    }
  });
});
