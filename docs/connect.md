# Connect your accounts

Each account is one connection, with its own credential, its own permissions, and its own label. Run
`lanes link connect <provider>` once per account you want reachable.

```console
$ lanes link connect gmail --profile personal --target local        # straight to the browser, nothing to register
$ lanes link connect gmail --profile personal --target local        # again, for a second mailbox
```

`lanes link status` shows what is connected and what that makes reachable.

## What you can connect

| | Connect with | What it gives your agent |
|---|---|---|
| Gmail | `lanes link connect gmail` | Read, search, send, draft, and organise mail |
| Google Drive | `lanes link connect drive` | Search, read, export, and share files |
| Google Sheets | `lanes link connect sheets` | Read and edit cells, ranges, and tabs |
| Google Docs | `lanes link connect docs` | Read a document and edit its content |
| Google Calendar | `lanes link connect calendar` | Read and write events, and answer when you are free |
| Google Tasks | `lanes link connect google_tasks` | Create, edit, complete, and reorder tasks |
| Google Contacts | `lanes link connect contacts` | Look up an address, so "email Bob" resolves. Read-only |
| iCloud Mail | `lanes link connect icloud_mail` | Read, search, and send over IMAP and SMTP |
| iCloud Calendar | `lanes link connect icloud_calendar` | Read and write events over CalDAV |
| iCloud Contacts | `lanes link connect icloud_contacts` | Look up an address over CardDAV |
| iCloud Drive | `lanes link connect icloud_drive` | Your sync folder, on the Mac that syncs it |
| Notion | `lanes link connect notion` | Notion's own MCP server |
| Linear | `lanes link connect linear` | Linear's own MCP server |
| GitHub | `lanes link connect github` | Repositories, issues, pull requests, and workflow runs |
| Slack | `lanes link connect slack` | Search, read, and send messages, threads, files, and canvases |
| Reddit | `lanes link connect reddit` | Read subreddits and comments, search, and post, comment, and vote as you |
| Discord | `lanes link connect discord` | Post announcements and read channels, as a bot application you own |
| Gmail (IMAP) | `lanes link connect gmail_imap` | The same mailbox over IMAP and SMTP, with an app password that does not expire |
| Gmail (Google MCP) | `lanes link connect gmail_mcp` | Google's own MCP server — Developer Preview only |
| Drive (Google MCP) | `lanes link connect drive_mcp` | Likewise; use `drive` unless you are enrolled |
| Outlook Mail † | `lanes link connect outlook_mail` | Read, search, file, and send over Microsoft Graph |
| Outlook Calendar † | `lanes link connect outlook_calendar` | Read and write events, and answer when you are free |
| Outlook Contacts † | `lanes link connect outlook_contacts` | Look up an address, so "email Bob" resolves. Read-only |
| OneDrive † | `lanes link connect onedrive` | Browse, search, read, and organise files |
| Microsoft To Do † | `lanes link connect microsoft_todo` | Create, edit, complete, and organise tasks and lists |
| Fastmail (all three) † | `lanes link connect fastmail` | Mail, Calendar, and Contacts together, on one app password |
| Fastmail Mail † | `lanes link connect fastmail_mail` | Read, search, and send over IMAP and SMTP |
| Fastmail Calendar † | `lanes link connect fastmail_calendar` | Read and write events over CalDAV |
| Fastmail Contacts † | `lanes link connect fastmail_contacts` | Look up an address over CardDAV |
| Zoho Mail † | `lanes link connect zoho_mail` | Read, search, and send over IMAP and SMTP |
| Yahoo Mail † | `lanes link connect yahoo_mail` | Read, search, and send over IMAP and SMTP |
| bunq | `lanes link connect bunq` | Accounts, balances, transaction history, and payments |

**† means untested.** The manifest is right in every way this repository can check — it validates,
its tools generate inside the budget, its scopes are described, its endpoint answered a probe — and
nobody has yet connected it to a real account. That is the part only a real account proves. The list
is [`src/providers/untested.ts`](../src/providers/untested.ts), and the tables here are checked
against it.

## Vendors that run their own MCP server

Each of these offers dynamic client registration, so there is no OAuth client to register and no
console to visit — `connect` registers us at the moment you run it.

| | Connect with | What your agent gets |
|---|---|---|
| Atlassian (Jira, Confluence) † | `lanes link connect atlassian` | Issues, pages, and components |
| Box † | `lanes link connect box` | Files and folders — needs an OAuth app of your own |
| HubSpot † | `lanes link connect hubspot` | CRM records — needs an MCP auth app of your own |
| Render † | `lanes link connect render` | Services and deploys — takes an API key you paste |
| Airtable † | `lanes link connect airtable` | Bases, tables, records, and schema |
| Algolia † | `lanes link connect algolia` | Search indices, records, queries, and synonyms |
| Amplitude † | `lanes link connect amplitude` | Events, charts, cohorts, and user activity |
| Apify † | `lanes link connect apify` | Actors, runs, datasets, and scraped results |
| Asana † | `lanes link connect asana` | Tasks, projects, portfolios, and workspaces |
| Attio † | `lanes link connect attio` | Records, lists, notes, and tasks in the CRM |
| Better Stack † | `lanes link connect betterstack` | Incidents, monitors, heartbeats, and logs |
| Bright Data † | `lanes link connect brightdata` | Web scraping, search results, and datasets |
| Buildkite † | `lanes link connect buildkite` | Pipelines, builds, jobs, and artifacts |
| Calendly † | `lanes link connect calendly` | Scheduled events, invitees, and availability |
| Canva † | `lanes link connect canva` | Designs, folders, brand templates, and exports |
| CircleCI † | `lanes link connect circleci` | Pipelines, workflows, jobs, and test results |
| ClickUp † | `lanes link connect clickup` | Tasks, lists, spaces, docs, and time entries |
| Close † | `lanes link connect close` | Leads, contacts, opportunities, and activities |
| Cloudflare (bindings) † | `lanes link connect cloudflare_bindings` | Workers KV, R2, D1, and Durable Objects |
| Cloudflare (observability) † | `lanes link connect cloudflare_observability` | Workers logs, analytics, and traces |
| Contentful † | `lanes link connect contentful` | Entries, assets, content types, and spaces |
| Datadog † | `lanes link connect datadog` | Metrics, logs, monitors, incidents, and dashboards |
| Dropbox † | `lanes link connect dropbox` | Files, folders, shared links, and file requests |
| Expensify † | `lanes link connect expensify` | Expenses, reports, and receipts |
| Figma † | `lanes link connect figma` | Files, designs, components, and Dev Mode context |
| Fireflies † | `lanes link connect fireflies` | Meeting transcripts, summaries, and action items |
| Flagsmith † | `lanes link connect flagsmith` | Feature flags, segments, and environments |
| Gamma † | `lanes link connect gamma` | Presentations and documents, generated and read back |
| Grafana † | `lanes link connect grafana` | Dashboards, datasources, queries, and alert rules |
| Heroku † | `lanes link connect heroku` | Apps, dynos, add-ons, releases, and logs |
| Hygraph † | `lanes link connect hygraph` | Content entries, models, and schema |
| Insightly † | `lanes link connect insightly` | Contacts, organisations, opportunities, and projects |
| Jam † | `lanes link connect jam` | Bug reports, with console logs, network calls, and repro steps |
| Klaviyo † | `lanes link connect klaviyo` | Profiles, lists, segments, campaigns, and flows |
| Mercury † | `lanes link connect mercury` | Accounts, balances, transactions, and cards |
| Miro † | `lanes link connect miro` | Boards, frames, sticky notes, and shapes |
| Mixpanel † | `lanes link connect mixpanel` | Events, funnels, retention, and cohorts |
| monday.com † | `lanes link connect monday` | Boards, items, groups, columns, and updates |
| Mux † | `lanes link connect mux` | Video assets, live streams, and playback analytics |
| Navan † | `lanes link connect navan` | Trips, bookings, and travel expenses |
| Neon † | `lanes link connect neon` | Postgres projects, branches, and SQL |
| Netlify † | `lanes link connect netlify` | Sites, deploys, functions, and environment variables |
| Paddle † | `lanes link connect paddle` | Products, prices, subscriptions, and transactions |
| PayPal † | `lanes link connect paypal` | Invoices, orders, payments, and disputes |
| PostHog † | `lanes link connect posthog` | Events, insights, feature flags, and session replays |
| Prisma † | `lanes link connect prisma` | Postgres databases, schema, and migrations |
| Ramp † | `lanes link connect ramp` | Cards, transactions, reimbursements, and spend limits |
| Recurly † | `lanes link connect recurly` | Subscriptions, invoices, and accounts |
| Remote † | `lanes link connect remote` | Employees, contracts, payroll, and time off |
| Replicate † | `lanes link connect replicate` | Models, predictions, and deployments |
| Resend † | `lanes link connect resend` | Transactional email, domains, and delivery events |
| Riverside † | `lanes link connect riverside` | Recordings, transcripts, and clips |
| Rootly † | `lanes link connect rootly` | Incidents, alerts, retrospectives, and on-call schedules |
| RudderStack † | `lanes link connect rudderstack` | Sources, destinations, and event streams |
| Salesloft † | `lanes link connect salesloft` | Cadences, people, and sales activity |
| Sanity † | `lanes link connect sanity` | Documents, datasets, schema, and content releases |
| Sentry † | `lanes link connect sentry` | Issues, events, stack traces, and releases |
| Shortcut † | `lanes link connect shortcut` | Stories, epics, iterations, and workflows |
| Square † | `lanes link connect square` | Payments, orders, catalog, inventory, and customers |
| Storyblok † | `lanes link connect storyblok` | Stories, components, assets, and spaces |
| Stripe † | `lanes link connect stripe` | Payments, customers, invoices, and subscriptions |
| Supabase † | `lanes link connect supabase` | Projects, database schema, SQL, and edge functions |
| Tavily † | `lanes link connect tavily` | Web search and page content extraction |
| Todoist † | `lanes link connect todoist` | Tasks, projects, sections, labels, and filters |
| Vercel † | `lanes link connect vercel` | Projects, deployments, build logs, and domains |
| Vimeo † | `lanes link connect vimeo` | Videos, folders, showcases, and analytics |
| Webflow † | `lanes link connect webflow` | Sites, pages, CMS collections, and items |
| Whimsical † | `lanes link connect whimsical` | Boards, flowcharts, wireframes, and mind maps |
| Wix † | `lanes link connect wix` | Sites, stores, bookings, and CMS data |
| Workable † | `lanes link connect workable` | Jobs, candidates, and interviews |
| Zapier † | `lanes link connect zapier` | Zaps, and the actions they reach across thousands of apps |

Two things follow from the vendor running the server rather than us.

**The tool list is theirs.** It is read at connect time, not declared in a manifest here, so it
tracks whatever they ship — new tools appear without a release from us, and a tool they withdraw
stops being served. `lanes link tools` is what tells you what a connection actually exposes
today.

**The audit log records the call, not the argument values.** Redaction is keyed on capability names
somebody authored, and here nobody did, so the default withholds every value. That is the right
default when we did not write the capability and cannot know what is sensitive — but it does mean
these connections give you a thinner record than Gmail or bunq do. `notion` and `linear` have always
worked this way; there are simply more of them now.

## Four things the table does not show

**Each Google product is its own connection.** Connecting Gmail does not imply Drive, Sheets, Docs,
Calendar, Tasks, or Contacts — each holds its own token under its own scopes. One OAuth client
covers all seven, so adding the second costs no new credentials, but each needs its API enabled and
its scopes registered. `lanes link connect` prints that console work the first time you connect each
product. Full walkthrough: [`detailed/setup/google.md`](detailed/setup/google.md).

**`lanes link connect icloud` sets up Mail, Calendar, and Contacts together**, because one
app-specific password covers all three. iCloud Drive is separate — it holds no credential at all,
reading your sync folder through the filesystem. Full walkthrough:
[`detailed/setup/icloud.md`](detailed/setup/icloud.md).

**bunq can move money, and nothing asks you to confirm.** Its payment tool executes immediately
and is not reversible — there is no approval step in the bunq app or anywhere else. Set a spending
limit on the API key, and if you want an agent to prepare payments rather than make them, deny the
two payment tools **and** `UPDATE_DraftPayment` — accepting a draft is itself how a draft is spent,
so leaving that one allowed lets an agent approve its own. Read
[`detailed/setup/bunq.md`](detailed/setup/bunq.md) before connecting it; it is the only page here
that is mostly about what not to do.

**GitHub, Reddit, and bunq ask you to register something.** Google and Slack authorise against the
client Lanes operates, Notion and Linear register themselves, and iCloud takes an app-specific
password you generate at appleid.apple.com. The other three each want one thing you make yourself:
GitHub a personal access token — [`detailed/setup/github.md`](detailed/setup/github.md) — Reddit an
OAuth client at reddit.com/prefs/apps, because it matches the loopback redirect exactly
([`detailed/setup/reddit.md`](detailed/setup/reddit.md)), and bunq an API key from inside the bunq
app, which is also where you set its spending limit.

Slack used to be on that list and no longer is. Slack does not register clients automatically and
is not going to — it would let a client authenticate someone without an app existing, and on
Enterprise Grid an admin approves each app first. What changed is whose app it is: Lanes registered
one, so `lanes link connect slack` is a browser round trip like the rest.

If your workspace has not approved that app — which an admin decides, not you — paste a token from
one it already trusts instead:

```console
$ lanes link connect slack --profile personal --target local --auth pasted_token
```

[`detailed/setup/slack.md`](detailed/setup/slack.md) covers both.

For Google you can still register your own, and some people have to — an organisation that forbids
third-party clients, a Workspace app that must be "Internal", or a hosted client that has reached
its account limit:

```console
$ lanes link connect gmail --profile personal --target local --own-client
```

That walks through the Google Cloud console once, stores the client id and secret, and records the
choice in your profile, so every later Google connection on that profile uses your client without
the flag. See [`detailed/setup/google.md`](detailed/setup/google.md) for the walkthrough and what
the two paths trade against each other.

## When the connection starts working

As soon as `connect` finishes. It saves the connection, copies the config to wherever the target's
endpoint reads it, and asks that endpoint to re-read it — so a running `lanes link start` picks it
up without a restart, and a deployed endpoint picks it up without a new revision. Deploying is how
new code gets to an endpoint; authorising an account changes no code (ADR-029).

The last line says which happened, and how many tools the endpoint now advertises:

```console
Next: Serving it now — the endpoint has re-read its config.
  42 tools are advertised now. A client connected before this keeps the
  list it already fetched — reconnect it to pick them up.
```

If no endpoint was running, or this machine cannot reach a deployed one, it says that instead. The
connection is saved either way and is served the next time that endpoint starts.

## Your agent needs reconnecting, though

An MCP client reads the tool list when it connects and keeps it. This endpoint cannot tell it
otherwise — it holds no session, so there is no channel to send a change on, and it says as much
rather than claiming there is (ADR-032). So a client registered before this connection still shows
the tools it saw then.

Remove and re-add it. For a hosted connector that is Disconnect and add the URL again; for a local
one, whatever your agent's equivalent is.

To see what a client would be handed right now:

```console
$ lanes link tools --profile personal --target local                # names by provider, payload size
$ lanes link tools --profile personal --target cloud # ask the deployed endpoint instead
```

If that count matches your client, its tools are current. If it does not, the client is holding an
old list and reconnecting is the fix.

Tools only, though. A skill is a *prompt*, not a tool, so adding one moves neither the count nor
the line `connect` prints — and skills are picked up by a running endpoint without a reload, so
nothing announces them either. After `lanes link skills add`, reconnect the client on the same
reasoning and without waiting for a number to change.

## See what one takes before you start

```console
$ lanes link setup plan --profile personal --target local               # every provider, connected or not
$ lanes link setup plan icloud_mail --profile personal --target local   # the steps, the values it will ask for, the command
```

An agent connected to your endpoint can see the same thing, so it can hand you the exact command
instead of guessing at one. That surface is read-only: connecting, credentials, and permissions stay
in this CLI.

## Permissions

Connecting grants a read bundle. Tightening is instant and local:

```console
$ lanes link policy list --profile personal
$ lanes link policy deny gmail.send gmail.main --profile personal --target local
```

A deny beats an allow whatever the order in the file. Widening a vendor scope is different — it
needs browser re-consent, through `lanes link connect <connection> --add <bundle>`.

## Connecting without a terminal to answer

For providers whose credential is a key or a password rather than a browser sign-in, an agent with a
shell can do the whole setup:

```console
$ printf %s "$TOKEN" | lanes link secrets set github/octocat --profile personal
$ lanes link connect github --id octocat --non-interactive --json --profile personal
```

`--non-interactive` never prompts. It resolves every value from the credential store, or refuses and
prints exactly what is missing and the command that stores it. Anything needing a browser consent is
refused outright rather than opening one nobody is watching.

Credentials go in on stdin, never as a flag — an argument lands in your shell history, in `ps`
output, and in any transcript.

## Add your own

Any MCP server, any REST API with an OpenAPI spec, any IMAP mailbox, any CalDAV or CardDAV server,
any folder on this machine. One command:

```console
$ lanes link connect custom thing --connector http --auth api-key --auth-header X-Api-Key \
    --base-url https://api.example.com/v1 --openapi https://api.example.com/openapi.json \
    --profile personal --target local
```

`--connector` is `mcp`, `http`, `imap`, `dav` or `fs`; `--auth` is `none`, `bearer`, `api-key`,
`header`, `basic`, `oauth` or `strategy`. Leave out a value it needs and it asks. What it writes is a
fifteen-line YAML manifest in `~/.lanes-link/data/<profile>/providers.d/` — the same declaration a
built-in is, and yours to edit from there.

See [`detailed/creating-a-provider.md`](detailed/creating-a-provider.md) to write one by hand, and
[`detailed/connectivity-coverage.md`](detailed/connectivity-coverage.md) for which combinations
work, which are closed on purpose, and what none of them covers yet.

---

**Full reference:** [`detailed/providers.md`](detailed/providers.md) lists every capability, why it
is a tool or a resource, and what its audit entries keep and withhold.
