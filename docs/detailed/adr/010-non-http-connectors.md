# ADR-010: connector kinds for protocols that are not HTTP

**Status:** accepted
**Supersedes nothing. Extends [ADR-008](008-connectors.md).**

## Context

ADR-008 said a provider is a manifest, not a package, and named three connector
kinds: `mcp`, `http`, `local`. It also left a note in `connector.ts` — *"if you
find yourself writing a fourth, ask first whether the manifest could describe it
instead."*

iCloud is the first account that forces the question. Apple publishes **no MCP
server and no REST API** for Mail, Calendar, or Contacts. CloudKit Web Services
exposes an app's own container, never the user's iCloud data. Mail is IMAP and
SMTP; Calendar and Contacts are CalDAV and CardDAV — HTTPS, but `PROPFIND` and
`REPORT` carrying XML, which no OpenAPI document describes.

So a manifest genuinely cannot describe it. There is no machine-readable
description of IMAP to point `http` at, because IMAP describes its *extensions*
through `CAPABILITY` and never its operations.

## Decision

Two new kinds: **`imap`** and **`dav`**.

The test they had to pass is **protocol code, not vendor code**. `http.ts` is 215
lines and serves Gmail, Drive, and every REST API that will ever exist. `imap.ts`
serves iCloud, Fastmail, and any Dovecot; `dav.ts` serves iCloud, Nextcloud, and
a Radicale on a Raspberry Pi. Neither mentions a vendor. iCloud itself is three
manifests of about fifteen lines, and Fastmail costs zero.

That test is the boundary. A kind that would name a vendor is the wrong shape,
and the answer there remains a manifest — or, for auth alone, an `AuthStrategy`.

### Capabilities are fixed, not discovered

ADR-008 says capabilities are discovered rather than declared. Both new kinds
return a **constant list** from `discover()`, and that is consistent rather than
an exception: the rule protects against a *manifest* declaring capabilities, and
neither manifest does. The difference is where the truth lives. For `mcp` the
vendor is the authority; for `imap` and `dav` the **protocol** is, and RFC 3501
does not change when Apple ships.

`discover()` still does real work. It authenticates — so a wrong app-specific
password fails at `connect` rather than as a puzzling tool failure three days
later — and it conditions the list on what the server actually supports:
`move_messages` appears only where `CAPABILITY` advertises `MOVE`, and
`send_message` only where the manifest configures SMTP.

### Per-connection routing does not go in `target`

The discovery cache is keyed by **provider**, not by connection. CalDAV
discovery resolves a home URL that is **per account** — iCloud answers from a
numbered partition host such as `p42-caldav.icloud.com` — so putting it in
`DiscoveredCapability.target` would have two Apple accounts share one entry, and
the second would read the first one's calendars. It lives in
`ProviderContext.state` instead, which is namespaced `<provider>/<connection>`
and object-backed, so statelessness holds exactly as before: a cold instance
serves without re-discovering.

### `imap` holds a session; the others do not

One socket per connection, reused for a burst, closed after idle. Not a pool: an
IMAP session is stateful — the selected mailbox *is* session state — so a pool
needs affinity or a re-`SELECT` per checkout, and its warm/cold divergence is the
thing ADR-002 asks us not to reason about. Apple throttles reconnection far
harder than an open session, so opening per call would turn a five-tool agent
turn into five TLS handshakes and five logins.

`Connector` gains `close()` for this, and `identify()` for a protocol whose
account name is not a URL away.

### Reading is read-only, and nothing can destroy mail

Structural rather than careful. Every IMAP read path uses `EXAMINE` rather than
`SELECT` and `BODY.PEEK[]` rather than `BODY[]`, so reading never sets `\Seen`.
Marking a message read is reachable only through `mark_messages`, in the write
bundle — never as an argument to a read capability, because an argument that
flips a capability's bundle defeats the split that policy is expressed in.

There is no `EXPUNGE`, and `\Deleted` is not in the settable-flag allowlist. An
agent that can permanently erase a mailbox is a different risk class from one
that can read it, and IMAP's delete is not recoverable through this connector.
If it is ever wanted, it is a third bundle, not a flag.

## Alternatives considered

**Drive the local macOS apps** (AppleScript/JXA/EventKit), which is what most
things named "Apple MCP" do — `apple-mcp`, `macos-mcp`, `osa-mcp`. It needs no
app-specific password at all, because it borrows the Mac's signed-in session,
and it reaches Notes, Reminders, and Messages, which IMAP and DAV cannot.

Rejected because it requires macOS, the apps running, and TCC grants: **it
cannot run on Cloud Run**, which is M3. It is the right answer for a Mac-only
tool and the wrong one for a gateway meant to be deployed.

**`imapflow`** for the IMAP client: eight direct dependencies pulling roughly
thirty transitive, including a logger and a SOCKS client, into a process holding
live refresh tokens. Verified first that `Bun.connect({tls: true})` reaches
`imap.mail.me.com:993` and that iCloud advertises `IMAP4rev1 SASL-IR AUTH=PLAIN`
— the exact subset needed — so the hand-rolled client is about 400 tested lines
against a roughly doubled dependency surface.

**`ical.js`** for iCalendar: zero dependencies, but 200 KB whose centrepiece is a
recurrence engine the protocol already provides — CalDAV's `<C:expand>` asks the
*server* to expand repeating events — and it is MPL-2.0, a licence nothing else
in this tree carries. Where a server ignores `<C:expand>`, the connector reports
`expanded: false` and hands back the `RRULE` verbatim: degrading honestly beats
expanding wrongly.

**A connector registry** allowing third-party kinds to be loaded. Rejected: that
means loading third-party *code* into a process holding credentials, which is a
far larger surface than YAML, and it is not what "generic" needs to mean here. An
operator adds a provider by writing a manifest for an existing kind. Adding a
*kind* is adding a protocol — rare, and it belongs in review.

## Consequences

- Three dependencies, each zero-dependency and verified from its published
  tarball: `postal-mime` (MIT-0), `nodemailer` (MIT-0), `@rgrove/parse-xml`
  (ISC). No transitive additions.
- `imap` and `dav` must declare `auth: basic`, enforced in `defineProvider`.
  Apple shipped an OAuth path for exactly these services in October 2025, but it
  is partner-gated with no published scopes, so a manifest declaring it would
  validate and then be unable to authenticate. If that opens up, auth is
  orthogonal to connectivity here: it is a change to the `auth` block and one arm
  of `ResolvedCredential`.
- **Reminders and Notes are out of reach.** Apple moved to-do lists to a private
  store after iOS 13; CalDAV returns legacy data or tombstones, and Notes were
  never exposed. Scope is Mail, Calendar, and Contacts, said out loud rather than
  discovered as a bug.
- Attachment *content* is not returned — only filename, type, and size. Handing
  over bytes needs somewhere for an agent to fetch them from, which is what MCP
  resources are for and what the owner layer will bring.

  Since resolved on the *sending* side only, by ADR-017: an attachment is named
  rather than carried, so the endpoint reads the bytes and an agent never holds
  them. Reading is unchanged, which makes the two directions asymmetric —
  forwarding works by naming the source message, not by fetching it first.
