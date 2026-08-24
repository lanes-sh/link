# Connecting Gmail, Drive, Sheets, Docs, Calendar, Tasks, and Contacts

```console
$ lanes link connect gmail
```

That is the whole of it. A browser opens, you approve the scopes, the connection is made.

Google requires a pre-registered OAuth client — Notion and Linear register themselves automatically,
Google does not offer that, **even for Google's own MCP servers**, and no architecture avoids it.
But it does not follow that *you* have to be the one who registers it. By default Lanes Link
authorises against a client Lanes operates, whose secret stays in the Lanes API and never reaches
your machine.

Two things that costs you, both worth knowing before you start:

- Until Google's verification completes you will see a **"Google hasn't verified this app"**
  screen. Choose **Advanced → Go to Lanes** to continue.
- The hosted client is limited to **100 Google accounts**, a cap Google counts for the lifetime of
  the project. `lanes link connect` warns as it fills and tells you what to do if it is full.

What it saves you is the rest of this page.

## Registering a client of your own

You would want to, and the rest of this page is how, if:

- your organisation does not permit third-party OAuth clients;
- all your accounts are on one Workspace domain and you want an **Internal** app, which never
  expires a refresh token and shows no warning screen;
- you would rather the authorization code and refresh token never passed through the Lanes API
  ([`../security.md`](../security.md) states exactly what that gives up);
- or the hosted client is at capacity.

```console
$ lanes link connect gmail --own-client
```

It asks for a client id and secret, stores them, and writes an `oauth_apps` entry to your profile.
That entry is the switch: once it is there, every Google connection on that profile uses your
client and you never need the flag again.

Going back to the hosted one takes two steps, not one. Deleting the entry leaves the client id and
secret in your credential store, and they still count — deliberately, so a profile whose config
lost the block is not moved onto a different client and left holding refresh tokens the new one
refuses. Remove the stored pair as well, or remove the profile
([`../configuration.md`](../configuration.md)). Either way, existing connections keep refreshing
against whichever client issued them, so moving one across means running `connect` for it again.

Everything below is that path.

---

## Two ways in, and the default is the one that works

| | `gmail` / `drive` | `gmail_mcp` / `drive_mcp` |
|---|---|---|
| Talks to | the Gmail and Drive **REST APIs** | Google's **MCP servers** |
| Who can use it | **anyone with a Google account** | Workspace Developer Preview members only |
| Tools | generated from Google's OpenAPI description | curated by Google |
| Setup | one OAuth client | one OAuth client, plus preview enrolment |

**Use `gmail` and `drive` unless you have a reason not to.** They are the plain names because they
are the ones that work.

### Why the MCP path is gated

Google's MCP servers are in Developer Preview, and without enrolment they fail in the worst possible
way — silently, and late:

```
$ lanes link connect gmail_mcp
ok    authorised                       ← consent succeeds
      13 capabilities discovered       ← tools/list succeeds

$ # …and then every single tool call:
      The caller does not have permission
```

Consent works. Discovery works. Only the calls fail, with a message that mentions neither preview
nor enrolment. The identical token calling the REST API directly returns your labels perfectly — so
it looks like a scope problem, and it is not.

Enrol at <https://developers.google.com/workspace/preview>. **It requires a Google Workspace
account; a personal `@gmail.com` cannot enrol.** If all your accounts are personal Gmail, the MCP
providers are simply unavailable to you — use `gmail` and `drive`, which have no gate.

---

## Choose the right path first

For a client of your own, this is the decision that determines everything else, and getting it
wrong is what sends people into Google's verification centre. None of it applies to the hosted
client, which is published and carries no seven-day expiry.

| Your accounts | User type | Verification | Refresh tokens |
|---|---|---|---|
| **A mix of personal Gmail and Workspace** | **External** | not needed, stay in Testing | **expire every 7 days** |
| Only accounts on one Workspace domain | Internal | never needed | never expire |

**If you have a mix — which is the common case — choose External.** "Internal" sounds like the
private option, but it only admits accounts on your own Workspace domain, so a personal `@gmail.com`
account simply cannot authorise against it.

**Do not publish an External app.** Gmail and Drive use *restricted* scopes, and publishing those
requires Google verification including a CASA Tier 2 security assessment — the process that asks for
a demo video, a homepage, and scope justifications, and takes months. Staying in **Testing** needs no
verification at all.

The price of Testing is real and worth knowing up front: **Google expires refresh tokens after seven
days**, so you will re-authorise roughly weekly. That is a Google policy setting, not a defect here,
and `lanes link doctor` tells you which connections have gone stale.

---

## Setup, once

Google reorganised this console: the old "APIs & Services → OAuth consent screen" is now the
**Google Auth Platform** at <https://console.cloud.google.com/auth>, and what used to be one wizard
is four separate pages. Enabling the APIs is still elsewhere.

| What you are setting | Where it lives now |
|---|---|
| App name, support email | Auth Platform → **Branding** |
| Internal vs External, test users, publishing status | Auth Platform → **Audience** |
| **Scopes** | Auth Platform → **Data access** |
| The OAuth client ID and secret | Auth Platform → **Clients** |
| Enabling the Gmail/Drive APIs | APIs & Services → **Library** |

### 1. Project and APIs

<https://console.cloud.google.com> — create or pick a project.

Then enable the APIs — whichever of the seven you mean to connect.

```console
$ gcloud services enable gmail.googleapis.com drive.googleapis.com \
    sheets.googleapis.com docs.googleapis.com \
    calendar-json.googleapis.com tasks.googleapis.com people.googleapis.com \
    --project=YOUR_PROJECT
```

Without `gcloud`, it is APIs & Services → **Library**, searching for "Gmail API", "Google Drive
API", "Google Sheets API", "Google Docs API", "Google Calendar API", "Google Tasks API", and
"People API".

**Calendar's service is `calendar-json.googleapis.com`, not `calendar.googleapis.com`.** The
plausible name is a different, unrelated service, and enabling it leaves consent succeeding and
every call answering 403 — the failure this whole page exists to prevent, with a name one word
away from the right one. In the Library search box the entry to click is "Google Calendar API".

`sheets` and `docs` need the **Drive** API enabled as well as their own. They label a connection by
asking `drive/v3/about` who you are, so with Drive disabled the connection authorises and then fails
to name itself.

**For `gmail_mcp` / `drive_mcp` only**, there are two APIs per product — the service and a separate
MCP API that fronts it. Enabling only the first is a trap: the MCP endpoint answers `403` with a
perfectly formed JSON-RPC body, and the one sentence explaining why is buried inside it.

```console
$ gcloud services enable gmailmcp.googleapis.com drivemcp.googleapis.com --project=YOUR_PROJECT
```

### 2. Branding

App name and a support email. Nothing here is seen by anyone but you.

### 3. Audience

**User type: External.** Choose External even with a Workspace domain — see the table above.

Add every Google account you intend to connect under **Test users** (up to 100), personal and
Workspace alike. An account not listed here cannot authorise.

**Leave the publishing status as "Testing".**

### 4. Data access

This is where scopes moved to. **Add or remove scopes**, and add these:

```
Gmail     https://www.googleapis.com/auth/gmail.readonly
          https://www.googleapis.com/auth/gmail.compose
          https://www.googleapis.com/auth/gmail.modify
          https://www.googleapis.com/auth/gmail.settings.basic
Drive     https://www.googleapis.com/auth/drive.readonly
          https://www.googleapis.com/auth/drive.file
Sheets    https://www.googleapis.com/auth/drive.readonly
          https://www.googleapis.com/auth/drive.file
          https://www.googleapis.com/auth/spreadsheets
Docs      https://www.googleapis.com/auth/drive.readonly
          https://www.googleapis.com/auth/drive.file
          https://www.googleapis.com/auth/documents
Calendar  https://www.googleapis.com/auth/calendar.readonly
          https://www.googleapis.com/auth/calendar.events
Tasks     https://www.googleapis.com/auth/tasks
Contacts  https://www.googleapis.com/auth/contacts.readonly
          https://www.googleapis.com/auth/contacts.other.readonly
```

Note `drive.file` is filed under **sensitive**, not restricted, so it appears in a different section
of the page from the others.

`gmail.modify` is what lets an agent organise mail, and Gmail leaves no way to ask for less. There
is no verb for read-state or spam: marking read removes the `UNREAD` label, marking spam adds
`SPAM`, archiving removes `INBOX`. All three are label edits, and `modify` is the only scope that
permits editing a message's labels — `gmail.labels` sounds narrower but governs the label
vocabulary, not its application. The cost is that `modify` also grants send and trash, which is why
`lanes link connect` marks it broad and makes you type `y`. It does **not** grant permanent delete;
that is `mail.google.com`, which nothing here requests.

Leave `gmail.modify` off if you want a read-and-draft mailbox. Everything else keeps working, and
the ten organising tools return 403.

`gmail.settings.basic` is what lets an agent **block a sender**, and it is worth a separate thought
because it is the only grant here that outlives the session. Reporting spam does not need it —
that is adding the `SPAM` label under `modify`, and it is what Gmail's own Report-spam button does.
Blocking is the other button: a *filter*, a standing rule created once that keeps acting on mail
that has not arrived yet. A filter with `addLabelIds: ["TRASH"]` keeps trashing mail after the
token expires and after you disable the connection; `lanes link policy deny` removes the tool and
cannot remove the rule. `filters.create` and `filters.delete` accept no narrower scope.

It is filed under **sensitive** rather than restricted, like `drive.file`, so look for it in that
section of the page. It does not grant `gmail.settings.sharing`, so auto-forwarding and delegation
stay out of reach.

Leave `gmail.settings.basic` off if you do not want standing rules. `filters_list` keeps working —
it accepts `gmail.readonly` — and `filters_create` and `filters_delete` return 403.

`spreadsheets` and `documents` are the same shape of decision, for the same reason. Every Sheets and
Docs operation is satisfied by `drive.file`, which is already on the list — but `drive.file` means
*files this app created*. Its other half, files you pick, arrives through the Google Picker, and
there is no picker on an MCP endpoint. So without the broader scope an agent can build a spreadsheet
and maintain it indefinitely, and cannot open the one you made in the browser last week.

Leave them off if that is the trade you want: `sheets` and `docs` keep working on their own files,
and return 403 on yours. Add them and an agent can edit anything of that type in the account — which
is why `lanes link connect` marks both broad and makes you type `y`. Neither grants `auth/drive`;
files that are not spreadsheets or documents stay read-only.

`calendar.events` is the same shape again, one product along. It reaches every event on every
calendar you can see, and it reaches nothing else — it cannot create a calendar, delete one, or
change who it is shared with. Those are `auth/calendar`, this product's `mail.google.com`, and
nothing here asks for it. Calendar does publish two narrower scopes, `calendar.events.owned` and
`calendar.app.created`, and neither is usable: Google's own API description does not list them
against these operations, so requesting one grants nothing the calls accept.

Leave `calendar.events` off and `calendar` becomes read-only — listing, searching, and free/busy
still work, and creating or moving an event returns 403. `calendar.readonly` is not optional: two
operations accept nothing narrower, and they are the list of your calendars and free/busy itself.

`tasks` is the one scope on this page with no argument behind it, because Google publishes no
alternative. Tasks has exactly two scopes, `tasks` and `tasks.readonly`, so adding a single task
means holding write and delete over every list in the account. Leave it off and there is no Tasks
provider — the read-only scope is not requested, because a to-do list you cannot write to is not
what anyone connected it for. What bounds it instead is the tool surface: `tasklists.delete` is not
vendored, so nothing exposed here can destroy a list and the tasks inside it.

Contacts asks for nothing broad. Both of its scopes are read-only, and there are two because Google
keeps contacts in two places: `contacts.readonly` is the address book you curated, and
`contacts.other.readonly` is where Gmail files an address you have written to but never saved —
which is where most lookups actually land. The write scope, `contacts`, permanently deletes and is
not requested.

The two MCP providers use the shorter list — `gmail.readonly` and `gmail.compose` only. They
*advertise* more, adding `gmail.metadata` and `mail.google.com` (read, send, and **permanently
delete**); Drive adds `auth/drive`. Requesting the full advertised set was tested against the live
service and changed nothing, because what gates those providers is Developer Preview enrolment
rather than scope — so they stay at what Google documents. `lanes link connect` prints whichever list
applies, in plain words, before the browser opens.

### 5. Clients

**Create OAuth client → Application type: Desktop app.** Then copy the client ID and secret.

`lanes link connect gmail` asks for them once per profile and stores them encrypted; only `_ref`
pointers ever reach the config file.

---

## Why Desktop app, even for Cloud Run

The obvious worry is that a deployed instance needs a "Web application" client with a public redirect
URI. It does not, and this is the payoff of a decision made early
([ADR-005](../adr/005-oauth-connection-flow.md)): **the OAuth flow runs in the CLI, never on the
server.**

```
lanes link connect gmail --target cloud
   → browser and loopback listener are on YOUR machine
   → the refresh token is written into the cloud target's credential store
   → the Cloud Run instance only ever USES that token; it never authorises
```

So the redirect URI is `http://127.0.0.1:<port>/callback` on your laptop whether the server ends up
local or deployed. The deployment target does not change the client type.

That is also why there is no public callback URL to register, no domain to verify, and no inbound
path to the server — a deployed instance exposes no administrative surface at all.

Google's own MCP documentation says "Web application", and tells you to register a redirect URI
belonging to **the agent host** — `https://claude.ai/api/mcp/auth_callback` for Claude,
`https://antigravity.google/oauth-callback` for Antigravity. That is right when the *host* runs the
OAuth flow and holds the tokens.

Here it does not. Lanes Link runs the flow itself and holds the tokens, which is the whole point:
the agent gets a policy-filtered endpoint, never your Google credentials. So the redirect belongs to
this CLI on loopback, and **Desktop app** is the correct type — the one client type that accepts any
loopback port without pre-registration.

---

## Connect

```console
$ lanes link connect gmail      # asks for client id + secret, then opens the browser
$ lanes link connect gmail      # second account — straight to the browser
$ lanes link connect drive      # reuses the same client; no prompts
$ lanes link connect sheets     # ditto, but do step 1 and step 4 for Sheets first
$ lanes link connect docs
$ lanes link connect calendar
$ lanes link connect tasks
$ lanes link connect contacts

$ lanes link connect gmail_mcp  # only if you are enrolled in the preview
```

**Adding a Google product to a profile that already has one is where this trips people up.** The
client ID and secret are shared, so there is nothing to type — but the console work is not shared.
Each product needs its own API enabled ([step 1](#1-project-and-apis)) and its own scopes added
([step 4](#4-data-access)), and skipping that fails in the two ways this page keeps warning about: a
scope you never registered is refused at the consent screen, and an API you never enabled consents
perfectly and then answers `403` on every call.

`lanes link connect` reprints the setup steps the first time you connect each product, for exactly
this reason. It does not reprint them on a re-authorisation.

At the consent screen you will see **"Google hasn't verified this app"**. That is expected for an
unverified Testing app. Click **Advanced → Go to \<app name\> (unsafe)** and continue. It is your own
app, registered in your own project, and the credentials never leave your machine.

Each run adds one account. The client ID and secret are asked for once per *profile*, not once per
account — all your Google connections authorise against the same registered client, which is what the
`oauth_apps` block in your config exists for, and what its presence tells Lanes Link to keep using
instead of the hosted client.

---

## The weekly re-authorisation

This is a property of **your own** External app while it is in Testing. Connections made against
the hosted client do not expire weekly, and `doctor` does not warn about their age.

With an External app in Testing, refresh tokens die after seven days. When one does, a call fails
with a message naming the cause and the fix:

```
The refresh token for gmail.work has expired or been revoked.
Re-authorise with: lanes link connect gmail.work
```

`lanes link doctor` reports stale connections before you hit them:

```console
$ lanes link doctor
warn  gmail.personal credential is 8 days old — Testing-status apps expire at 7. Run: lanes link connect gmail.personal
```

If the weekly cycle becomes annoying, the escapes are:

- **Use the hosted client** — drop `--own-client`, remove the `oauth_apps` entry *and* the stored
  `google/client_id` and `google/client_secret` (both, for the reason above), then run
  `lanes link connect` again for each account. That client is published, so its refresh tokens do
  not expire weekly.
- **Move those accounts to a Workspace domain** and use an Internal app — no expiry, no warning
  screen, no verification.
- **Complete Google's verification** for your External app — weeks to months, and for restricted
  scopes it includes a paid third-party security assessment. What the review asks for, scope by
  scope, is in [`../google-verification.md`](../google-verification.md); it is written for the
  hosted client but the questions are the same for yours.

There is no fourth. Anything claiming otherwise is either using non-restricted scopes or is about
to stop working.

---

## When something goes wrong

| Symptom | Cause |
|---|---|
| `invalid_grant`, roughly weekly | Expected in Testing. Re-run `lanes link connect <connection>`. |
| `invalid_grant` immediately | The account is not in **Test users**, or the grant was revoked at <https://myaccount.google.com/permissions>. |
| 403 "Insufficient Permission" | The API is not enabled, or the consent did not include the scope. |
| Tools list fine but every call says **"The caller does not have permission"** | You are on `gmail_mcp` / `drive_mcp` without [Workspace Developer Preview](https://developers.google.com/workspace/preview) enrolment. Not a scope problem. Switch to `gmail` / `drive`, which use the REST API and have no gate. |
| 403 mentioning an API you thought you enabled | On the MCP providers there are **two** APIs per product: `gmail`/`gmailmcp` and `drive`/`drivemcp`. Enabling only one is the usual cause. |
| A tool you expected is missing from `gmail` / `drive` | Their tool lists come from a vendored OpenAPI subset in `src/providers/google/specs/`. Add the operationId to `src/providers/google/specs/vendor.ts` and re-run it. |
| The tool list did not change after a version bump | The served list comes from the discovery cache, not the spec. Re-run `lanes link connect <connection>` to refresh it. |
| 403 on the Gmail organising tools only | The consent predates `gmail.modify`. Add it under **Data access** first, then re-run `lanes link connect <connection>` — a refresh keeps the old grant and will not pick it up. |
| 403 on the Gmail filter tools only | The consent predates `gmail.settings.basic`. Add it under **Data access** first, then re-run `lanes link connect <connection>`. `filters_list` keeps working, which is the tell: it accepts `gmail.readonly`. |
| 403 on every Calendar call, but consent worked | The enabled service is `calendar.googleapis.com`. Calendar's is **`calendar-json.googleapis.com`** — see [step 1](#1-project-and-apis). |
| No tool to fetch one contact by resource name | Deliberate. Google writes those paths with a reserved-expansion placeholder that holds a slash (`people/me`), and the generated tool percent-encodes it into `people%2Fme`, which 404s. `contacts` searches instead; the reasoning is in `src/providers/google/specs/vendor.ts`. |
| `redirect_uri_mismatch` | The client is a "Web application". Create a **Desktop app** client instead — see above. |
| Cannot find where to add scopes | Auth Platform → **Data access**, not the old consent-screen wizard. |
| Cannot find "Create credentials" | Auth Platform → **Clients** → Create OAuth client. |
| "Access blocked: has not completed verification" | The account is not in Test users. Add it. |
| No refresh token returned | The account already authorised this app. Revoke at <https://myaccount.google.com/permissions> and retry. |

`lanes link audit tail` shows what was actually attempted, with arguments redacted.
