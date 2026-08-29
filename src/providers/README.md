# Providers

A hundred and two of them, and almost all are a folder and a line. This page is the inventory and the
ins and outs; [`docs/connect.md`](../../docs/connect.md) is the same list written for someone
deciding what to connect.

## What a provider is

Two choices and nothing else: **how a service is reached** (`connector.kind`) and **how we prove who
we are** (`auth.kind`). Both are closed unions, both are orthogonal, and everything else is data
hung off the pair. That is why iCloud can speak IMAP with a password while Gmail speaks HTTP with
OAuth and neither costs the other any code.

- [`../connectivity/transports/README.md`](../connectivity/transports/README.md) — the six ways to reach a service
- [`../connectivity/auth/README.md`](../connectivity/auth/README.md) — the credential types, and the ones not built yet
- [`../../docs/detailed/connectivity-coverage.md`](../../docs/detailed/connectivity-coverage.md) — which pairs work, which are refused, and why

Where they come from:

| | |
|---|---|
| **connector** | `mcp` 77 · `http` 15 · `imap` 5 · `dav` 4 · `fs` 1 |
| **auth** | `oauth (dynamic)` 70 · `oauth (manual)` 18 · `basic` 9 · `bearer` 2 · `header` 1 · `none` 1 · `strategy` 1 |

Two of the hundred and two are code rather than data — `gmail`, which assembles an RFC 2822 message to
send one, and `bunq`, which runs a signing handshake no declarative form describes. Everything else
is a manifest.

## Tested means somebody connected it

**Twenty-one are tested. Eighty-one are not**, and the tables say which.

A manifest can be right in every way this repository can check and still not work. What the checks
prove: the schema validates, the vendored spec generates registrable tools inside the 64 KB budget,
every scope has a described meaning, the redaction keys name arguments that exist, and — for the
remote MCP servers — the endpoint answered a live protocol probe with an OAuth challenge.

What only a real account proves: that the grant is the right one, that the identity probe reads a
field the vendor actually returns, that a refresh token comes back, and that the tool list is worth
having. Until somebody has done that, the honest label is untested — not broken, and not a warning,
just a fact about what has been established.

The list is [`untested.ts`](untested.ts), it is the single source of truth, and
`../readme.test.ts` asserts the documentation marks exactly those and no others. A provider leaves
the list when somebody connects it and it does what it says.

## Adding one

A folder here and a line in [`index.ts`](index.ts). That file says it too, and means it: the folder
holds *all* of the provider — the manifest, the scopes it asks for, what it redacts from the audit
log, the setup walkthrough, and any vendored specification.

The full walkthrough is [`docs/detailed/creating-a-provider.md`](../../docs/detailed/creating-a-provider.md),
which opens by pointing out that most providers should not be built-ins at all — a YAML manifest in
a profile's own `providers.d/` is validated by the same schema and loaded by [`custom/`](custom/).

Four things bite, and all four are quiet:

1. **A redaction key that misses is invisible.** It withholds every argument and reads exactly like
   working redaction. Key it on the capability name *as served* — Microsoft Graph's operations are
   `me.ListMessages`, dots and all, because `shortenName` strips the provider id and the provider is
   not called "me".
2. **Schema size is not spec size.** `mcp-from-openapi` inlines `$ref`s, so a request body that
   references a wide entity explodes: Graph's `PATCH /me/messages` measured 346 KB against a 64 KB
   budget. `projectRequestBody` is the remedy where the body is a schema reference, and it is
   checked — a field the vendor renames fails the refresh instead of becoming an argument the API
   ignores.
3. **A property key the Anthropic API refuses takes down every provider at once**, not just its own.
   `^[a-zA-Z0-9_.-]{1,64}$`, and one bad key rejects the whole `tools` array. The `http` transport
   renames them and leaves the wire name alone, so OData's `$top` reaches an agent as `top`.
4. **`base_url` must equal the spec's own `servers[0].url`**, and the version lives in different
   places per vendor — Drive puts it in the host, Sheets in the path. Copying the wrong one 404s
   every call.

## The inventory

`tested` is blank where nobody has connected it yet.

| id | name | connector | auth | tested |
|---|---|---|---|---|
| `fastmail_calendar` | Fastmail Calendar | `dav` | `basic` |  |
| `fastmail_contacts` | Fastmail Contacts | `dav` | `basic` |  |
| `icloud_calendar` | iCloud Calendar | `dav` | `basic` | yes |
| `icloud_contacts` | iCloud Contacts | `dav` | `basic` | yes |
| `icloud_drive` | iCloud Drive | `fs` | `none` | yes |
| `bunq` | bunq | `http` | `strategy` | yes |
| `calendar` | Google Calendar | `http` | `oauth (manual)` | yes |
| `contacts` | Google Contacts | `http` | `oauth (manual)` | yes |
| `discord` | Discord | `http` | `header` | yes |
| `docs` | Google Docs | `http` | `oauth (manual)` | yes |
| `drive` | Google Drive | `http` | `oauth (manual)` | yes |
| `gmail` | Gmail | `http` | `oauth (manual)` | yes |
| `google_tasks` | Google Tasks | `http` | `oauth (manual)` | yes |
| `microsoft_todo` | Microsoft To Do | `http` | `oauth (manual)` |  |
| `onedrive` | OneDrive | `http` | `oauth (manual)` |  |
| `outlook_calendar` | Outlook Calendar | `http` | `oauth (manual)` |  |
| `outlook_contacts` | Outlook Contacts | `http` | `oauth (manual)` |  |
| `outlook_mail` | Outlook Mail | `http` | `oauth (manual)` |  |
| `reddit` | Reddit | `http` | `oauth (manual)` | yes |
| `sheets` | Google Sheets | `http` | `oauth (manual)` | yes |
| `fastmail_mail` | Fastmail Mail | `imap` | `basic` |  |
| `gmail_imap` | Gmail (IMAP) | `imap` | `basic` | yes |
| `icloud_mail` | iCloud Mail | `imap` | `basic` | yes |
| `yahoo_mail` | Yahoo Mail | `imap` | `basic` |  |
| `zoho_mail` | Zoho Mail | `imap` | `basic` |  |
| `airtable` | Airtable | `mcp` | `oauth (dynamic)` |  |
| `algolia` | Algolia | `mcp` | `oauth (dynamic)` |  |
| `amplitude` | Amplitude | `mcp` | `oauth (dynamic)` |  |
| `apify` | Apify | `mcp` | `oauth (dynamic)` |  |
| `asana` | Asana | `mcp` | `oauth (dynamic)` |  |
| `atlassian` | Atlassian | `mcp` | `oauth (dynamic)` |  |
| `attio` | Attio | `mcp` | `oauth (dynamic)` |  |
| `betterstack` | Better Stack | `mcp` | `oauth (dynamic)` |  |
| `box` | Box | `mcp` | `oauth (manual)` |  |
| `brightdata` | Bright Data | `mcp` | `oauth (dynamic)` |  |
| `buildkite` | Buildkite | `mcp` | `oauth (dynamic)` |  |
| `calendly` | Calendly | `mcp` | `oauth (dynamic)` |  |
| `canva` | Canva | `mcp` | `oauth (dynamic)` |  |
| `circleci` | CircleCI | `mcp` | `oauth (dynamic)` |  |
| `clickup` | ClickUp | `mcp` | `oauth (dynamic)` |  |
| `close` | Close | `mcp` | `oauth (dynamic)` |  |
| `cloudflare_bindings` | Cloudflare Bindings | `mcp` | `oauth (dynamic)` |  |
| `cloudflare_observability` | Cloudflare Observability | `mcp` | `oauth (dynamic)` |  |
| `contentful` | Contentful | `mcp` | `oauth (dynamic)` |  |
| `datadog` | Datadog | `mcp` | `oauth (dynamic)` |  |
| `drive_mcp` | Google Drive (Google MCP) | `mcp` | `oauth (manual)` | yes |
| `dropbox` | Dropbox | `mcp` | `oauth (dynamic)` |  |
| `expensify` | Expensify | `mcp` | `oauth (dynamic)` |  |
| `figma` | Figma | `mcp` | `oauth (dynamic)` |  |
| `fireflies` | Fireflies | `mcp` | `oauth (dynamic)` |  |
| `flagsmith` | Flagsmith | `mcp` | `oauth (dynamic)` |  |
| `gamma` | Gamma | `mcp` | `oauth (dynamic)` |  |
| `github` | GitHub | `mcp` | `bearer` | yes |
| `gmail_mcp` | Gmail (Google MCP) | `mcp` | `oauth (manual)` | yes |
| `grafana` | Grafana | `mcp` | `oauth (dynamic)` |  |
| `heroku` | Heroku | `mcp` | `oauth (dynamic)` |  |
| `hubspot` | HubSpot | `mcp` | `oauth (manual)` |  |
| `hygraph` | Hygraph | `mcp` | `oauth (dynamic)` |  |
| `insightly` | Insightly | `mcp` | `oauth (dynamic)` |  |
| `jam` | Jam | `mcp` | `oauth (dynamic)` |  |
| `klaviyo` | Klaviyo | `mcp` | `oauth (dynamic)` |  |
| `linear` | Linear | `mcp` | `oauth (dynamic)` | yes |
| `mercury` | Mercury | `mcp` | `oauth (dynamic)` |  |
| `miro` | Miro | `mcp` | `oauth (dynamic)` |  |
| `mixpanel` | Mixpanel | `mcp` | `oauth (dynamic)` |  |
| `monday` | monday.com | `mcp` | `oauth (dynamic)` |  |
| `mux` | Mux | `mcp` | `oauth (dynamic)` |  |
| `navan` | Navan | `mcp` | `oauth (dynamic)` |  |
| `neon` | Neon | `mcp` | `oauth (dynamic)` |  |
| `netlify` | Netlify | `mcp` | `oauth (dynamic)` |  |
| `notion` | Notion | `mcp` | `oauth (dynamic)` | yes |
| `paddle` | Paddle | `mcp` | `oauth (dynamic)` |  |
| `paypal` | PayPal | `mcp` | `oauth (dynamic)` |  |
| `posthog` | PostHog | `mcp` | `oauth (dynamic)` |  |
| `prisma` | Prisma | `mcp` | `oauth (dynamic)` |  |
| `ramp` | Ramp | `mcp` | `oauth (dynamic)` |  |
| `recurly` | Recurly | `mcp` | `oauth (dynamic)` |  |
| `remote` | Remote | `mcp` | `oauth (dynamic)` |  |
| `render` | Render | `mcp` | `bearer` |  |
| `replicate` | Replicate | `mcp` | `oauth (dynamic)` |  |
| `resend` | Resend | `mcp` | `oauth (dynamic)` |  |
| `riverside` | Riverside | `mcp` | `oauth (dynamic)` |  |
| `rootly` | Rootly | `mcp` | `oauth (dynamic)` |  |
| `rudderstack` | RudderStack | `mcp` | `oauth (dynamic)` |  |
| `salesloft` | Salesloft | `mcp` | `oauth (dynamic)` |  |
| `sanity` | Sanity | `mcp` | `oauth (dynamic)` |  |
| `sentry` | Sentry | `mcp` | `oauth (dynamic)` |  |
| `shortcut` | Shortcut | `mcp` | `oauth (dynamic)` |  |
| `slack` | Slack | `mcp` | `oauth (manual)` | yes |
| `square` | Square | `mcp` | `oauth (dynamic)` |  |
| `storyblok` | Storyblok | `mcp` | `oauth (dynamic)` |  |
| `stripe` | Stripe | `mcp` | `oauth (dynamic)` |  |
| `supabase` | Supabase | `mcp` | `oauth (dynamic)` |  |
| `tavily` | Tavily | `mcp` | `oauth (dynamic)` |  |
| `todoist` | Todoist | `mcp` | `oauth (dynamic)` |  |
| `vercel` | Vercel | `mcp` | `oauth (dynamic)` |  |
| `vimeo` | Vimeo | `mcp` | `oauth (dynamic)` |  |
| `webflow` | Webflow | `mcp` | `oauth (dynamic)` |  |
| `whimsical` | Whimsical | `mcp` | `oauth (dynamic)` |  |
| `wix` | Wix | `mcp` | `oauth (dynamic)` |  |
| `workable` | Workable | `mcp` | `oauth (dynamic)` |  |
| `zapier` | Zapier | `mcp` | `oauth (dynamic)` |  |
