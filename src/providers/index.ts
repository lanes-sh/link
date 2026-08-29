import type { ProviderDefinition, ProviderManifest } from '#connectivity';
import { bunq } from './bunq/index.ts';
import { calendar } from './google/calendar/index.ts';
import { discord } from './discord/index.ts';
import { contacts } from './google/contacts/index.ts';
import { docs } from './google/docs/index.ts';
import { github } from './github/index.ts';
import { drive } from './google/drive/index.ts';
import { driveMcp } from './google/drive-mcp/index.ts';
import { gmail } from './google/gmail/index.ts';
import { gmailImap } from './google/gmail-imap/index.ts';
import { gmailMcp } from './google/gmail-mcp/index.ts';
import { sheets } from './google/sheets/index.ts';
import { googleTasks } from './google/tasks/index.ts';
import { icloudCalendar } from './icloud/calendar/index.ts';
import { icloudContacts } from './icloud/contacts/index.ts';
import { icloudDrive } from './icloud/drive/index.ts';
import { icloudMail } from './icloud/mail/index.ts';
import { microsoftTodo } from './microsoft/todo/index.ts';
import { onedrive } from './microsoft/drive/index.ts';
import { outlookCalendar } from './microsoft/calendar/index.ts';
import { outlookContacts } from './microsoft/contacts/index.ts';
import { outlookMail } from './microsoft/mail/index.ts';
import { fastmailCalendar } from './fastmail/calendar/index.ts';
import { fastmailContacts } from './fastmail/contacts/index.ts';
import { fastmailMail } from './fastmail/mail/index.ts';
import { yahooMail } from './yahoo_mail/index.ts';
import { zohoMail } from './zoho_mail/index.ts';
import { linear } from './linear/index.ts';
import { notion } from './notion/index.ts';
import { reddit } from './reddit/index.ts';
import { slack } from './slack/index.ts';
import { asana } from './asana/index.ts';
import { stripe } from './stripe/index.ts';
import { sentry } from './sentry/index.ts';
import { figma } from './figma/index.ts';
import { canva } from './canva/index.ts';
import { dropbox } from './dropbox/index.ts';
import { todoist } from './todoist/index.ts';
import { clickup } from './clickup/index.ts';
import { monday } from './monday/index.ts';
import { airtable } from './airtable/index.ts';
import { miro } from './miro/index.ts';
import { calendly } from './calendly/index.ts';
import { close } from './close/index.ts';
import { zapier } from './zapier/index.ts';
import { paypal } from './paypal/index.ts';
import { square } from './square/index.ts';
import { mercury } from './mercury/index.ts';
import { vercel } from './vercel/index.ts';
import { netlify } from './netlify/index.ts';
import { supabase } from './supabase/index.ts';
import { neon } from './neon/index.ts';
import { prisma } from './prisma/index.ts';
import { sanity } from './sanity/index.ts';
import { webflow } from './webflow/index.ts';
import { wix } from './wix/index.ts';
import { datadog } from './datadog/index.ts';
import { grafana } from './grafana/index.ts';
import { fireflies } from './fireflies/index.ts';
import { gamma } from './gamma/index.ts';
import { jam } from './jam/index.ts';
import { cloudflareObservability } from './cloudflare_observability/index.ts';
import { cloudflareBindings } from './cloudflare_bindings/index.ts';
import { atlassian } from './atlassian/index.ts';
import { hubspot } from './hubspot/index.ts';
import { box } from './box/index.ts';
import { render } from './render/index.ts';
import { algolia } from './algolia/index.ts';
import { amplitude } from './amplitude/index.ts';
import { apify } from './apify/index.ts';
import { attio } from './attio/index.ts';
import { betterstack } from './betterstack/index.ts';
import { brightdata } from './brightdata/index.ts';
import { buildkite } from './buildkite/index.ts';
import { circleci } from './circleci/index.ts';
import { contentful } from './contentful/index.ts';
import { expensify } from './expensify/index.ts';
import { flagsmith } from './flagsmith/index.ts';
import { heroku } from './heroku/index.ts';
import { hygraph } from './hygraph/index.ts';
import { insightly } from './insightly/index.ts';
import { klaviyo } from './klaviyo/index.ts';
import { mixpanel } from './mixpanel/index.ts';
import { mux } from './mux/index.ts';
import { navan } from './navan/index.ts';
import { paddle } from './paddle/index.ts';
import { posthog } from './posthog/index.ts';
import { ramp } from './ramp/index.ts';
import { recurly } from './recurly/index.ts';
import { remote } from './remote/index.ts';
import { replicate } from './replicate/index.ts';
import { resend } from './resend/index.ts';
import { riverside } from './riverside/index.ts';
import { rootly } from './rootly/index.ts';
import { rudderstack } from './rudderstack/index.ts';
import { salesloft } from './salesloft/index.ts';
import { shortcut } from './shortcut/index.ts';
import { storyblok } from './storyblok/index.ts';
import { tavily } from './tavily/index.ts';
import { vimeo } from './vimeo/index.ts';
import { whimsical } from './whimsical/index.ts';
import { workable } from './workable/index.ts';

/**
 * Every provider, in one list.
 *
 * Names and imports only. There is no vendor knowledge in this file and there
 * must never be any — a Google scope, an Apple error message, or a spec path
 * appearing here means it has escaped the folder that owns it.
 *
 * Each folder holds *all* of its provider: the manifest, the scopes it asks
 * for, what it redacts from the audit log, the setup walkthrough, and any
 * vendored specification. Adding a provider is a folder and a line below.
 *
 * The list is a convenience, not a boundary: anything not here is a YAML
 * manifest in the profile's own `providers.d/`, validated by the same schema and
 * loaded by `./custom/load.ts`.
 *
 * The owner layer — `memory/`, `skills/`, `vault/` — is deliberately absent
 * from this list and not from this directory. Those three are providers in
 * every sense the architecture cares about, but they are *constructed* rather
 * than declared: each needs a store handed to it at startup, so they are
 * registered by `#profile`'s registry builder instead of being static data.
 */
/**
 * Manifests, and the rare provider that carries a capability of its own.
 *
 * The union is not an invitation. A provider is a *declaration*, and that is what
 * makes adding one cheap; `gmail` is a definition only because sending mail means
 * assembling a MIME message and no document describes doing that. Everything else
 * here is still fifteen lines of data. `registry.register` already accepted both
 * shapes, so nothing downstream had to change.
 */
export const PROVIDERS: readonly (ProviderManifest | ProviderDefinition)[] = [
  notion,
  linear,
  github,
  slack,
  reddit,
  discord,
  gmail,
  drive,
  sheets,
  docs,
  calendar,
  googleTasks,
  contacts,
  gmailImap,
  gmailMcp,
  driveMcp,
  icloudMail,
  icloudCalendar,
  icloudContacts,
  icloudDrive,
  outlookMail,
  outlookCalendar,
  outlookContacts,
  onedrive,
  microsoftTodo,
  fastmailMail,
  fastmailCalendar,
  fastmailContacts,
  zohoMail,
  yahooMail,
  bunq,

  // Vendors running an official MCP server that offers Dynamic Client
  // Registration. Each is a declaration and nothing else; see the header above.
  asana,
  stripe,
  sentry,
  figma,
  canva,
  dropbox,
  todoist,
  clickup,
  monday,
  airtable,
  miro,
  calendly,
  close,
  zapier,
  paypal,
  square,
  mercury,
  vercel,
  netlify,
  supabase,
  neon,
  prisma,
  sanity,
  webflow,
  wix,
  datadog,
  grafana,
  fireflies,
  gamma,
  jam,
  cloudflareObservability,
  cloudflareBindings,
  atlassian,
  hubspot,
  box,
  render,
  algolia,
  amplitude,
  apify,
  attio,
  betterstack,
  brightdata,
  buildkite,
  circleci,
  contentful,
  expensify,
  flagsmith,
  heroku,
  hygraph,
  insightly,
  klaviyo,
  mixpanel,
  mux,
  navan,
  paddle,
  posthog,
  ramp,
  recurly,
  remote,
  replicate,
  resend,
  riverside,
  rootly,
  rudderstack,
  salesloft,
  shortcut,
  storyblok,
  tavily,
  vimeo,
  whimsical,
  workable,
];

/** The manifest half of an entry, whichever shape it arrived in. */
export const manifestOf = (entry: ProviderManifest | ProviderDefinition): ProviderManifest =>
  'manifest' in entry ? entry.manifest : entry;

/**
 * Every provider's manifest, for the callers that only ask about declarations —
 * which scopes are requested, which are `http`, what `base_url` each names.
 *
 * Derived rather than a second list, so it cannot fall out of step with the one
 * above.
 */
export const PROVIDER_MANIFESTS: readonly ProviderManifest[] = PROVIDERS.map(manifestOf);

export {
  calendar,
  contacts,
  docs,
  drive,
  driveMcp,
  gmail,
  gmailImap,
  gmailMcp,
  googleTasks,
  sheets,
} from './google/index.ts';
export { icloudCalendar, icloudContacts, icloudDrive, icloudMail } from './icloud/index.ts';
export {
  microsoftTodo,
  onedrive,
  outlookCalendar,
  outlookContacts,
  outlookMail,
} from './microsoft/index.ts';
export { fastmailCalendar, fastmailContacts, fastmailMail } from './fastmail/index.ts';
export { yahooMail } from './yahoo_mail/index.ts';
export { zohoMail } from './zoho_mail/index.ts';
export { bunq } from './bunq/index.ts';
export { discord } from './discord/index.ts';
export { github } from './github/index.ts';
export { linear } from './linear/index.ts';
export { notion } from './notion/index.ts';
export { reddit } from './reddit/index.ts';
export { slack } from './slack/index.ts';
export { asana } from './asana/index.ts';
export { stripe } from './stripe/index.ts';
export { sentry } from './sentry/index.ts';
export { figma } from './figma/index.ts';
export { canva } from './canva/index.ts';
export { dropbox } from './dropbox/index.ts';
export { todoist } from './todoist/index.ts';
export { clickup } from './clickup/index.ts';
export { monday } from './monday/index.ts';
export { airtable } from './airtable/index.ts';
export { miro } from './miro/index.ts';
export { calendly } from './calendly/index.ts';
export { close } from './close/index.ts';
export { zapier } from './zapier/index.ts';
export { paypal } from './paypal/index.ts';
export { square } from './square/index.ts';
export { mercury } from './mercury/index.ts';
export { vercel } from './vercel/index.ts';
export { netlify } from './netlify/index.ts';
export { supabase } from './supabase/index.ts';
export { neon } from './neon/index.ts';
export { prisma } from './prisma/index.ts';
export { sanity } from './sanity/index.ts';
export { webflow } from './webflow/index.ts';
export { wix } from './wix/index.ts';
export { datadog } from './datadog/index.ts';
export { grafana } from './grafana/index.ts';
export { fireflies } from './fireflies/index.ts';
export { gamma } from './gamma/index.ts';
export { jam } from './jam/index.ts';
export { cloudflareObservability } from './cloudflare_observability/index.ts';
export { cloudflareBindings } from './cloudflare_bindings/index.ts';
export { atlassian } from './atlassian/index.ts';
export { hubspot } from './hubspot/index.ts';
export { box } from './box/index.ts';
export { render } from './render/index.ts';
export { algolia } from './algolia/index.ts';
export { amplitude } from './amplitude/index.ts';
export { apify } from './apify/index.ts';
export { attio } from './attio/index.ts';
export { betterstack } from './betterstack/index.ts';
export { brightdata } from './brightdata/index.ts';
export { buildkite } from './buildkite/index.ts';
export { circleci } from './circleci/index.ts';
export { contentful } from './contentful/index.ts';
export { expensify } from './expensify/index.ts';
export { flagsmith } from './flagsmith/index.ts';
export { heroku } from './heroku/index.ts';
export { hygraph } from './hygraph/index.ts';
export { insightly } from './insightly/index.ts';
export { klaviyo } from './klaviyo/index.ts';
export { mixpanel } from './mixpanel/index.ts';
export { mux } from './mux/index.ts';
export { navan } from './navan/index.ts';
export { paddle } from './paddle/index.ts';
export { posthog } from './posthog/index.ts';
export { ramp } from './ramp/index.ts';
export { recurly } from './recurly/index.ts';
export { remote } from './remote/index.ts';
export { replicate } from './replicate/index.ts';
export { resend } from './resend/index.ts';
export { riverside } from './riverside/index.ts';
export { rootly } from './rootly/index.ts';
export { rudderstack } from './rudderstack/index.ts';
export { salesloft } from './salesloft/index.ts';
export { shortcut } from './shortcut/index.ts';
export { storyblok } from './storyblok/index.ts';
export { tavily } from './tavily/index.ts';
export { vimeo } from './vimeo/index.ts';
export { whimsical } from './whimsical/index.ts';
export { workable } from './workable/index.ts';
export { SCOPE_MEANINGS, type ScopeMeaning } from './scopes.ts';
export { UNTESTED_PROVIDERS } from './untested.ts';
