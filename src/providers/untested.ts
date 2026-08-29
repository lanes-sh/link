/**
 * Providers nobody has connected to a real account yet.
 *
 * A manifest can be right in every way this repository can check — the schema
 * validates, the spec generates registrable tools inside the budget, the scopes
 * are described, the endpoint answered an unauthenticated probe — and still not
 * work. What none of that proves is the part only a live account proves: that
 * the grant is the right one, that the identity probe reads a field the vendor
 * actually returns, that a refresh token comes back, that the tool list is worth
 * having.
 *
 * So this is an honest label rather than a warning. Everything here is expected
 * to work and is shipped in that belief; none of it has been used in anger. A
 * provider leaves this list when somebody connects it and it does what it says.
 *
 * One list, and the documentation is checked against it — `src/readme.test.ts`
 * asserts the tables mark exactly these and no others, because a status that is
 * maintained in three places is a status that is wrong in two of them.
 */
export const UNTESTED_PROVIDERS: ReadonlySet<string> = new Set([
  'airtable',
  'algolia',
  'amplitude',
  'apify',
  'asana',
  'attio',
  'betterstack',
  'brightdata',
  'buildkite',
  'calendly',
  'canva',
  'circleci',
  'clickup',
  'close',
  'cloudflare_bindings',
  'cloudflare_observability',
  'contentful',
  'datadog',
  'dropbox',
  'expensify',
  'fastmail_calendar',
  'fastmail_contacts',
  'fastmail_mail',
  'figma',
  'fireflies',
  'flagsmith',
  'gamma',
  'grafana',
  'heroku',
  'hygraph',
  'insightly',
  'jam',
  'klaviyo',
  'mercury',
  'microsoft_todo',
  'miro',
  'mixpanel',
  'monday',
  'mux',
  'navan',
  'neon',
  'netlify',
  'onedrive',
  'outlook_calendar',
  'outlook_contacts',
  'outlook_mail',
  'paddle',
  'paypal',
  'posthog',
  'prisma',
  'ramp',
  'recurly',
  'remote',
  'replicate',
  'resend',
  'riverside',
  'rootly',
  'rudderstack',
  'salesloft',
  'sanity',
  'sentry',
  'shortcut',
  'square',
  'storyblok',
  'stripe',
  'supabase',
  'tavily',
  'todoist',
  'vercel',
  'vimeo',
  'webflow',
  'whimsical',
  'wix',
  'workable',
  'yahoo_mail',
  'zapier',
  'zoho_mail',
  'atlassian',
  'hubspot',
  'box',
  'render',
]);
