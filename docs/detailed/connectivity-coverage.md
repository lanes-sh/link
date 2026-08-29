# Connectivity coverage

A provider is two choices: how a service is reached, and how we prove who we are. Both are closed
discriminated unions — `connector.kind` in
[`connector.ts`](../../src/connectivity/manifest/connector.ts) and `auth.kind` in
[`auth.ts`](../../src/connectivity/manifest/auth.ts) — and everything else about a provider is data
hung off the pair. `lanes link connect custom` exists to compose them, so this page is the honest
account of what that composition reaches.

It is written to be read in two directions. If you are declaring a provider, the matrix says
whether your pair works. If you are deciding what to build next, the second half says what no pair
covers and what each gap would cost.

## How to read this

Four states, not two:

| | |
|---|---|
| **works** | Expressible in a manifest today. **Proven by** names a built-in that exercises it; blank means legal and unexercised — nothing refuses it, and the first operator to declare it is the test. |
| **closed** | `defineProvider` refuses it, on purpose. The rule is in [Why a cell is closed](#why-a-cell-is-closed). |
| **not built** | Nothing refuses it in principle. No code exists. No cell is in this state today — it is what the gaps in the second half are. |
| **n/a** | Not a combination to build. |

One thing the union's shape hides: **`auth.assertion` is not a `kind`.** RFC 7523 — sign a JWT with
a key you hold and exchange it for a token — hangs off the OAuth block instead, and the reasoning is
the rule this whole page is measured against:

> Declared *on* the OAuth block rather than as a fourth `kind`, because it is an alternative
> arrangement for the same provider rather than a different provider.

So it is a column here, not a row. Which arrangement a connection actually uses is decided by the
*shape of the stored credential*, not by config.

## The matrix

| connector | none | oauth | bearer | api_key | header | basic | strategy | oauth + assertion |
|---|---|---|---|---|---|---|---|---|
| **mcp** | works | works — `notion`, `linear`, `slack`, `gmail_mcp`, `drive_mcp`, and the sixty-seven in [The DCR directory](#the-dcr-directory) | works — `github` | closed **R7** | closed **R7** | closed **R7** | closed **R7** | closed **R4** |
| **http** | works | works — `gmail`, `drive`, `sheets`, `docs`, `calendar`, `tasks`, `contacts`, `reddit` | works | works | works — `discord` | works | works — `bunq` | works — the seven Google providers, via a service-account key |
| **imap** | closed **R5** | closed **R5** | closed **R5** | closed **R5** | closed **R5** | works — `icloud_mail`, `gmail_imap`, `fastmail_mail`, `zoho_mail`, `yahoo_mail` | closed **R5** | n/a |
| **dav** | closed **R5** | closed **R5** | closed **R5** | closed **R5** | closed **R5** | works — `icloud_calendar`, `icloud_contacts`, `fastmail_calendar`, `fastmail_contacts` | closed **R5** | n/a |
| **fs** | works — `icloud_drive` | closed **R6** | closed **R6** | closed **R6** | closed **R6** | closed **R6** | closed **R6** | n/a |
| **local** | works — the owner layer, `example` | closed **R6** | closed **R6** | closed **R6** | closed **R6** | closed **R6** | closed **R6** | n/a |

Three readings worth stating plainly.

**`http` is the row where the open cells are.** All eight of them are open, and it is where every
custom provider that is not an MCP server or a mailbox will land. Four are unexercised, which is a
gap in *evidence* rather than in the schema — and the one `connect custom` starts closing, which is
why the round-trip test over every legal pair matters more than it looks.

**`strategy` is only open on `http`, and that follows from what a strategy is.** It signs or
negotiates an HTTP request, so it needs a request to sign: `mcp` sends exactly one header and
permits only three credential types (R7), `imap` and `dav` authenticate with a password (R5), and
`fs` makes no request at all (R6). `connect custom` refuses the other four by name.

**R5 is the only closure with an expiry date.** Its stated reason is that OAuth for mail and DAV is
partner-gated with no published scopes. That is a fact about 2025, not about IMAP. When a vendor
publishes scopes, R5 becomes wrong and two cells open.

## The DCR directory

Sixty-seven of the `mcp` + `oauth` entries are one cell of this matrix exercised sixty-seven times,
and they are worth naming as a group because the thing they have in common is what makes them cheap:
every one advertises **Dynamic Client Registration** in its authorization-server metadata. There is
no client to register, no console to visit, and nothing for an operator to supply — `connect`
registers us at the moment it runs. Each is fifteen lines and no code.

`airtable` · `algolia` · `amplitude` · `apify` · `asana` · `attio` · `betterstack` ·
`brightdata` · `buildkite` · `calendly` · `canva` · `circleci` · `clickup` · `close` ·
`cloudflare_bindings` · `cloudflare_observability` · `contentful` · `datadog` · `dropbox` ·
`expensify` · `figma` · `fireflies` · `flagsmith` · `gamma` · `grafana` · `heroku` · `hygraph` ·
`insightly` · `jam` · `klaviyo` · `mercury` · `miro` · `mixpanel` · `monday` · `mux` · `navan` ·
`neon` · `netlify` · `paddle` · `paypal` · `posthog` · `prisma` · `ramp` · `recurly` · `remote`
· `replicate` · `resend` · `riverside` · `rootly` · `rudderstack` · `salesloft` · `sanity` ·
`sentry` · `shortcut` · `square` · `storyblok` · `stripe` · `supabase` · `tavily` · `todoist` ·
`vercel` · `vimeo` · `webflow` · `whimsical` · `wix` · `workable` · `zapier`

**None of them declares `scopes`, and that is the decision rather than an omission.**
`CredentialOAuthProvider.clientMetadata` puts a `scope` on the registration request *only* when the
manifest declares one, so an empty list means the authorization server applies its own default for
the resource. That is the honest answer when the vendor owns both the server and the vocabulary: a
subset guessed from `scopes_supported` and never exercised is how you ship a manifest that
registers cleanly, authorises cleanly, and is then permitted to do nothing — the failure R8 exists
to prevent for assertions. `notion` has worked this way since it was written. `linear` is the
exception and declares `['read', 'write']`, because Linear documents that pair as the whole
vocabulary.

Two consequences worth stating where somebody will find them. **`refresh_token` stays `required`**,
its default: a server that returns no refresh token gets refused at `connect` rather than working
for an hour and dying. And **none declares `redact`**, because redaction keys on capability names
and an `mcp` provider's capabilities are discovered — so the default withholds every argument value.
That is the right default for a capability we did not author, and it is the same one `notion` and
`linear` have always had; there are simply sixty-seven more of them now.

`local` is in the matrix for completeness and cannot be declared: it means the capability code is
ours, compiled into this build. `connect custom` refuses it by name.

## Why a cell is closed

Every rule is in [`defineProvider`](../../src/connectivity/manifest/provider.ts), and each exists
because the alternative validates and then does not work.

| | Rule | What it closes |
|---|---|---|
| **R2** | `oauth` + `registration: manual` needs an `app`, and needs either a `broker` or setup prompts | a manual client with nowhere to come from. "Otherwise there is no way to learn what to provide." |
| **R3** | a `broker` needs `manual`, an `app`, and an `authorize_url` — plus a `token_url` on `mcp`, and never a `redirect_uri` | an exchange with nowhere to route. On `mcp` the SDK owns the flow and "has nowhere to route an exchange somebody else performs" (ADR-040). |
| **R4** | `mcp` + `assertion` is refused | the assertion column for `mcp`. "The SDK owns an mcp provider's exchange and takes a client, not a signed assertion — so the choice would be offered, accepted, and then have nowhere to go." |
| **R5** | `imap` and `dav` must declare `basic` | 10 cells. "Every mail and DAV host that matters issues an app password and expects it over Basic. OAuth for these exists — Apple shipped one in Oct 2025 — but is partner-gated with no published scopes, so declaring it would be a manifest that validates and then cannot authenticate." |
| **R6** | `fs` and `local` must declare `none` | 10 cells. "Nothing to authenticate to. The permission is the operating system's, held against the process, and there is no credential to store or to leak." |
| **R7** | `mcp` auth must be `none`, `oauth` or `bearer`, may not rename its header, and `connector.headers` may not set `Authorization` | 3 cells. "The transport sends exactly one header, `Authorization: Bearer <token>`, because that is what the MCP specification says a client sends… Such a manifest validates and then connects *unauthenticated* — no error, an empty tool list, and nothing to read that says why." |
| **R8** | an assertion needs non-empty `scopes` and its own prompts | a token "permitted to do nothing" that only reports at the first call. |
| **R9** | a token credential may not declare both `app` and `credential_ref` | one secret per account across a vendor versus one across every account. "Pick the one that is true." |
| **R10** | a `shared` prompt must name a ref; a `connection` prompt must not | a ref that "would name a connection that does not exist yet". |
| **R11** | `basic` needs exactly one `username` prompt and one `password` | `basic` stores `username:password` and cannot be assembled from anything else. |

There is no rule refusing `strategy` itself, and there was briefly one here that should not have
been. A strategy names code, and whether a name reaches any is the *registry's* question rather than
the schema's — `strategyFor` looks at the manifest's own definition and then at every other
registered provider's, and `refuseStrategy` is what says a name reaches nothing. That indirection is
the point: it is what lets a declaration-only manifest in `providers.d/` borrow a registered
strategy by name, which is the only way to point a connection at a vendor's sandbox, since a
built-in manifest's `options` are not the operator's to edit
([ADR-046](adr/046-an-auth-strategy-belongs-to-its-provider.md)).

`connect custom` refuses R4–R7 in its own words before writing anything, naming the alternative
rather than the rule. The rule fires regardless a moment later; the sentence is the part somebody
acts on.

## What a capability *is* depends on the connector

This decides what a custom provider can do, which is a different question from whether it connects.

| connector | capabilities come from |
|---|---|
| `http` | **discovered** — the OpenAPI document, through `mcp-from-openapi`, filtered by `operations` |
| `mcp` | **discovered** — the upstream server's `tools/list` |
| `imap` | **fixed** — `imap/capabilities.ts`, conditioned on whether SMTP was declared and whether the server supports `MOVE` |
| `dav` | **fixed** — `dav/capabilities.ts`, conditioned on `caldav` or `carddav` |
| `fs` | **fixed** — "a folder is a folder" |
| `local` | **authored** — Zod schemas in our own code |

So a manifest adds *capabilities* only on the two discovered rows. On `imap`, `dav` and `fs` it
chooses a host and some limits and gets whatever the protocol's fixed set is. That is the right
trade and it is deliberate — as `connector.ts` puts it, "the capability set belongs to the connector
rather than to the manifest", because IMAP describes its extensions and never its operations.

## What no cell covers

Each gap ends with a cost, in one of four sizes: **schema only** · **a folder, a schema member and a
resolve case** (the unit `connectivity/auth/README.md` claims for itself) · **a change to a
transport or to dispatch** · **a whole transport**.

One thing to read the auth gaps against first. Now that the strategy seam is real, several of them
have a *second* answer that costs nothing here: a folder under `providers/` and a line in that
provider's index. `sigv4` is the clearest case — request signing over a keypair the operator holds is
exactly the shape `providers/bunq/strategy/` already is. A strategy is the right home when the
arrangement belongs to *one vendor*, and a `kind` is the right home when it is a standard several
vendors implement the same way, because only then does a shared implementation have anything to
share. Client credentials below is a standard; SigV4 is one vendor's.

### OAuth 2.0 client credentials

The commonest machine-to-machine arrangement — a client id and secret, no browser, no person — and
there is no path to it. The only grant types in the tree are `refresh_token`,
`authorization_code`, and `urn:ietf:params:oauth:grant-type:jwt-bearer`. The absence is recorded in
the code: "The other flows the credential-type list names — client credentials, SigV4 — are sibling
folders that do not exist yet."

**Cost: a folder, a schema member and a resolve case — plus two CLI touch points the README does not
count.** `connect` needs a `ChosenMethod` member and an arm beside the assertion and pasted-token
routes, because there is no browser to open and no static prompt to fill.

One shape decision is worth settling in advance. As a new `auth.kind`, `rotatableCredentialRefs`
returns nothing for it — so a deployed revision caching an access token gets no write binding and
starts refusing about an hour after reporting healthy. Hung off the OAuth block as
`auth.client_credentials`, following the assertion precedent, refs and grants are unchanged. The
second shape is the right one, and it can cache in process memory and persist nothing at all, which
is what the assertion path already does.

### A REST API with no OpenAPI document

`openapi` is required on an `http` connector and there is no path around it: the transport hands the
string straight to the generator, and discovery is entirely that generator's output.

**There is already a zero-code answer, and it should be documented rather than built:** write a
five-operation OpenAPI document by hand and put it beside the manifest. A relative `openapi:`
resolves against the manifest's own directory, and `upload.ts` carries a `.json` in `providers.d/`
to a deployed bucket along with the manifest. For a service where you want six calls and not six
hundred, hand-writing the six is less work than reading a vendor's spec anyway.

**Cost if built: schema only, plus a synthesiser.** An `operations: [{ id, method, path, parameters
}]` block and a function that emits an OpenAPI document from it, leaving the transport and the
discovery path untouched. A second declaration format is the thing to avoid; a second *front end*
onto the same one is fine.

### GraphQL

No transport handles it, and there is no cell for it. Linear rides `mcp` — which is the answer for
any vendor operating an MCP server over their own GraphQL API, and increasingly they do.

An `http` connector can technically reach `POST /graphql` if a spec describes it with a free-form
body, and that is worse than nothing: the query becomes a string the model composes against a schema
nothing validated, and `operations.include` — the filter that keeps a tool list reasonable — has
exactly one operation to choose from.

**Cost: a whole transport**, including introspection-driven discovery as the analogue of reading a
spec. Out of scope, and the reason is not the cost: the set of services reachable by GraphQL and not
by MCP is small and shrinking.

### ~~One address per manifest~~ — closed by ADR-055

`base_url`, `endpoint` and `host` were one value per manifest, which made a built-in impossible for
any service whose address is a property of the *account* rather than of the vendor: every
self-hosted thing, and every multi-tenant SaaS whose host carries the tenant.

A manifest may now put `{placeholders}` in its connector's address and declare `variables` that fill
them; `connect` asks, the connection's own `config` stores the answer, and the factory substitutes
before building. **No transport changed** — a variable decides where a connector points and nothing
about how it speaks — which is the property the gaps below are measured against.

```yaml
id: mailbox
name: Mailbox
connector:
  kind: imap
  host: "{imap_host}"
  smtp:
    host: "{smtp_host}"
auth:
  kind: basic
identity:
  kind: connector
variables:
  - key: imap_host
    label: IMAP server
    description: Where mail is read from.
    example: imap.example.com
    pattern: "^[a-z0-9][a-z0-9.-]*[a-z0-9]$"
  - key: smtp_host
    label: SMTP server
    description: Where mail is sent from.
    example: smtp.example.com
    pattern: "^[a-z0-9][a-z0-9.-]*[a-z0-9]$"
setup:
  prompts:
    - key: username
      label: Username
      scope: connection
      field: username
    - key: password
      label: Password
      secret: true
      scope: connection
      field: password
```

The **pattern is the part to read twice**. A value goes into a URL, so an unconstrained one chooses
the host the operator's credential is sent to. The default admits one label and no dots; a provider
whose value is legitimately a whole hostname overrides it, and that override still refuses `/`, `@`,
`:` and everything else that turns a host into a different address. It is enforced at substitution
rather than only at the prompt, because config is a file someone can edit and a deployed revision
reads it without ever seeing a prompt.

What this does **not** close: an `http` provider still needs an OpenAPI document, so Zendesk and
Shopify are expressible and not yet written.

### Pagination, cursors, rate limits, retries

None of it is expressible. The `http` transport is one `fetch` and one response: no retry, no
backoff, no `429` handling, no `Retry-After`, no cursor following. The rate limiting that exists is
inbound — token buckets protecting the endpoint, not the vendor.

So it is the model's problem, mediated by the spec: a `pageToken` parameter becomes a tool argument,
the next cursor comes back in the response body, and the model passes it again. A `429` is returned
as an error result carrying the vendor's status line, and whether anything retries is up to the
agent.

**Cost: a change to a transport** — and worth flagging as a *different kind* of cost from everything
in the auth README, whose whole claim is that its gaps touch no transport, no provider and no
dispatch path. This one touches a transport. It is also the likeliest first surprise for somebody
pointing a custom provider at a paginated list endpoint.

### `refresh_token: optional` cannot be written in YAML

A vendor that issues a long-lived token and no refresh token needs `refresh_token: optional`, or
`connect` treats the successful response as a failure. Slack is exactly this case, and declares it —
but Slack is a built-in, and a built-in calls `defineProvider` directly.

A YAML manifest cannot. The entropy check that guards a manifest refuses any key matching
`_token` that is not a `_ref`, on the raw document before the schema sees it — and `refresh_token`
matches. The check is right about the general case and wrong about this key.

**Cost: schema only, in the sense that no behaviour changes** — but the fix is in
`secret-detection.ts`, which guards every config file in the system, so it wants care rather than
volume. An exact-name exemption for `auth.refresh_token`, or a rule that a value inside a known enum
is not a credential.

### `redact` on a provider nobody authored

A manifest without a `redact` block gets `redactAllValues`, which reduces every argument to a type
marker. So the audit log records that something happened and nothing about what.

**This is the right default and the page should not hedge about it.** The alternative is a default
that leaks, chosen on behalf of an operator who has not yet seen the capability list — and as
`provider.ts` says, it "is the only safe default when we did not author the capability and cannot
know what is sensitive". It is also not a custom-provider problem: `notion` and `linear` declare no
`redact` either. The built-ins that have one have it because somebody sat down and wrote it, and
`tasks/redact.ts` records how easy it is to get wrong — "a wrong key here fails silently — the
lookup misses, every value is withheld, and it reads exactly like working redaction."

There is a real option here, recorded and not recommended. By the time `connect` finishes it holds
every discovered capability name and input schema, so it could write a commented `redact:` skeleton
back into the manifest — one key per capability, empty array — giving the operator somewhere to opt
keys in that they will otherwise never find. **Cost: no schema change and no dispatch change**, but
it introduces a class of write nothing in this codebase does: rewriting a manifest.

### Webhooks, server-push, and the protocols that are not here

Out of scope with a reason rather than a shrug. The endpoint is stateless by design, so there is no
stream on which to send a notification and no durable subscription to hold — and server-push also
needs an inbound public URL. The decision is already applied once: Google Calendar's `watch`
operations are excluded from the vendored spec because "the `watch` operations push to a webhook this
endpoint does not have".

SFTP, S3 and gRPC are each **a whole transport**, and each would follow the `imap`/`dav`/`fs` shape
rather than `http`'s — a fixed capability set in the transport, because none of them has a document
describing its operations.

SQL should be refused outright, and it is worth saying why here rather than discovering it later:
the policy layer's unit is a capability name, and the honest capability for a SQL transport is
"execute an arbitrary query" — one name covering everything, so one grant covering everything.
Default deny would still be on and would still mean nothing.

## Keeping this page honest

The examples below are held to the same standard as
[`creating-a-provider.md`](creating-a-provider.md): `src/profile/docs.test.ts` parses every fenced
YAML block on this page that declares an `id` and a `connector`, through the same `parseManifest`
the loader runs. A matrix is more dangerous than a how-to, because its examples are exactly the edge
cells nobody has run.

One of each open row, so every cell claimed above has something behind it:

```yaml
id: docs_server
name: Docs Server
connector:
  kind: mcp
  endpoint: https://mcp.example.com/mcp
auth:
  kind: none
```

```yaml
id: thing
name: Thing
connector:
  kind: http
  base_url: https://api.example.com/v1
  openapi: https://api.example.com/openapi.json
  headers:
    User-Agent: thing:1.0 (by someone)
auth:
  kind: api_key
  header: X-Api-Key
setup:
  prompts:
    - key: api_key
      label: Thing API key
      secret: true
      scope: connection
```

```yaml
id: mailbox
name: Mailbox
connector:
  kind: imap
  host: imap.example.com
  smtp:
    host: smtp.example.com
    port: 465
    starttls: false
auth:
  kind: basic
identity:
  kind: connector
setup:
  prompts:
    - key: username
      label: Username
      scope: connection
      field: username
    - key: password
      label: App password
      secret: true
      scope: connection
      field: password
```

```yaml
id: notes
name: Notes
connector:
  kind: fs
  root: ~/Notes
auth:
  kind: none
identity:
  kind: connector
```

Every one of these is what `lanes link connect custom` writes for the corresponding pair — the
command's own tests derive all twelve legal pairs and assert each survives being read back by the
loader, so this page and that command cannot disagree for long.
