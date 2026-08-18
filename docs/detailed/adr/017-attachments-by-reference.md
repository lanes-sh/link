# ADR-017: Attachments are named, not carried — and a provider may author a capability

**Status:** accepted
**Date:** 2026-08-12

## Context

Someone using this endpoint tried to email a 239 KB PDF and could not. Their report named the
cause exactly: the only way to attach anything was to put the file in the tool call as base64,
and 239 KB is roughly 320,000 characters once encoded — past what a model can write in one
message. The mail went out describing an attachment it did not have.

The obvious reading is that a size limit needs raising. That reading is wrong, and worth
correcting because it points at the wrong fix. Nothing here capped the send path — not the
schema, not dispatch, not the HTTP layer — and Gmail's own ceiling is 35 MiB
(`users.messages.send`, `maxSize: 36700160`, from its discovery document). A 239 KB PDF is about
427 KB of base64url, which that endpoint accepts without complaint. The binding constraint was
never the wire. It was that **the bytes had to pass through the model** to get here.

Two gaps produced the one symptom:

- `icloud_mail.send_message` had a clean structured schema and no `attachments` field at all.
- Gmail had **no send tool**, deliberately — "the token can send, the tool surface cannot". What
  existed was `drafts.create` and `drafts.send`, and both accept only `raw`: the whole RFC 2822
  message, base64url. So even a plain-text Gmail message obliged the caller to hand-build MIME.

## Decision

### Attachments are named by reference; the endpoint fetches the bytes

One attachment carries exactly one source key:

| Source | Means |
| --- | --- |
| `path` | A file on the machine running this endpoint. Read as-is. |
| `url` | Fetched over HTTPS by the endpoint, with the checks below. |
| `handle` | Bytes staged earlier through the upload route. |
| `message_id` | An attachment already on a message in this mailbox. |
| `data` | Base64 inline — the escape hatch, not the path. |

Exactly one, enforced at runtime rather than resolved by precedence. Silently preferring one
source would make the other look like it worked, and which file got attached is the last thing
anyone would check.

This is also the only shape available. MCP has no client-to-server binary channel in any released
version of the protocol, nor in the 2026-07-28 release candidate: base64 in `tools/call` arguments
is the whole of it. `roots` never carried bytes — only paths on the client's host — and is
deprecated as of 2026-07-28 (SEP-2577), unimplemented by both Claude Desktop and Claude Code. The
live standards work, SEP-2631, converges on precisely this shape: an out-of-band upload returning
an opaque handle that then travels as an ordinary tool argument.

### A remote provider may carry a few capabilities of its own

Server-side MIME assembly needs our own code on the Gmail path, and until now only a `local`
connector carried code. Three alternatives were considered:

- **Teach the HTTP transport to compose mail.** It is the generic transport; mail knowledge in it
  is vendor knowledge in shared code, which `architecture.test.ts` refuses on purpose.
- **A second provider holding just the send.** It would need its own connection, so one mailbox
  would appear twice, consent and identity labelling would split, and a policy rule would have to
  name both.
- **Reach another provider's credential from a handler.** `ProviderContext` states plainly that a
  provider cannot reach another connection. That guarantee is worth more than this feature.

So `defineProviderWithCapabilities` pairs a manifest with a handful of authored capabilities;
`createCompositeConnector` answers those names and delegates everything else. `discover()`
delegates untouched, because authored capabilities are code and a cached row naming one would
outlive a rename. The registry adds both sets together, with authored winning a collision —
replacing the generated version is the reason to write one.

**This is the exception, not the pattern.** A provider is a declaration precisely so that Gmail is
fifteen lines of data rather than six hundred lines of endpoint translation, and every authored
capability is a step back toward the latter. The bar is that the vendor's API can do something its
*document* cannot express.

`ProviderContext` gained an optional `authorize`, the same closure dispatch already handed the
connector context. A provider authoring a call its transport cannot express makes that call
through the credential path the transport would have used, and still cannot read the credential,
name another connection, or reach a store it did not declare.

### Sending is now a tool on Gmail

`gmail.send_message`, with `draft_only` for the review step. This reverses "the tool surface cannot
send", knowingly: the `gmail.compose` scope already permitted it, and
`lanes link policy deny gmail.send_message` still takes it away. What changes is that composing
the message is our job, which is the only way the bytes stay out of the model.

Two submission routes, chosen by size. Under 5 MB the message goes as base64url in JSON — the
ordinary endpoint, and the overwhelming majority of sends. Over it, the upload host takes raw MIME
as `message/rfc822` with `uploadType=media`, which lifts the ceiling to Gmail's own 35 MiB.
Refusing at 5 MB would have been a limit we invented.

### `path` is unrestricted, and the audit record is what makes that defensible

No allowlist, no confinement to a root. The endpoint already holds its owner's credentials, so the
filesystem is treated the same way, and `docs/detailed/creating-a-provider.md` already says provider code is
trusted code.

What makes it defensible is the record rather than a sandbox. Every resolved attachment carries a
SHA-256 and an origin (`path:/Users/…`, `mailbox:18f…`, `handle:att_…`, `inline`), and the send path
annotates them. `redact` could not express this: it only keeps an argument verbatim, and
`attachments` is the one argument that may *be* a file — keeping it would put base64 in the audit
log. So `send_message: []` stays and the resolved facts are annotated instead. Without that, "was
`id_rsa` ever mailed out" has no answer.

For the same reason the tool result is a **receipt** — name, size, type, digest — never the bytes.
Returning content would rebuild the context problem in the other direction and, with unrestricted
paths, quietly turn a send tool into a general file-read tool.

### `url` is checked before it is fetched

HTTPS only. Every resolved address inspected rather than the first. Each redirect hop re-checked.
The body capped while streaming instead of trusting `Content-Length`. On a hosted deployment the
interesting target is one hop away — `169.254.169.254` hands out a service account token to
anything that asks — and the threat model is concrete: an agent that just read a hostile email and
was told to attach a file from a URL.

IP literals are not parsed by hand; MCP's own security guidance is blunt that custom parsers miss
octal, hex and IPv4-mapped-IPv6 forms, so the only addresses classified are ones `isIP` accepted as
canonical or DNS produced. The residual TOCTOU window is recorded in `url.ts` rather than papered
over: closing it needs the socket pinned to the validated address, which `fetch` does not expose,
and rewriting the URL to a literal IP would break TLS verification — trading a narrow race for a
broken check.

### Staging is per connection

A `path` names the filesystem the *server* can see, which on Cloud Run is a container and not the
operator's Mac. So bytes may also arrive out of band: `POST /attachments`, or
`lanes link attach <file> --connection <provider>.<account>`, both through
`Dispatcher.stageAttachment`.

In dispatch rather than in the transport for two reasons. `server` may not reach a store — how
blobs are namespaced is not something a component that speaks HTTP should know. And staging is a
write against one account: it puts the operator's file *inside* the endpoint, where a later send can
post it outward, so it belongs in the same log as the send.

Staged into the connection's own namespace, not a shared one, because the store handed to a
provider is already namespaced by provider and connection and the point of that is that one
account's bytes are not reachable from another. Handles expire after a day and are swept on write —
there is no scheduler in this process, and the moment someone stages is the most reliable time to
clear the last batch.

## Consequences

- Attaching a file no longer costs context. Forwarding one that arrived by mail costs none at all:
  the bytes go mailbox → MIME without being seen.
- Gmail can send in one call, and can send a plain message without hand-built base64.
- A new way to write a provider exists, and it can be misused. The bar is stated above and
  `defineProviderWithCapabilities` refuses the two obvious misreadings — a `local` connector, and an
  empty capability list.
- `path` is an exfiltration primitive by construction. It is accepted knowingly, mitigated by the
  audit record, and revocable per capability through policy.
- **An existing iCloud connection must be re-connected once**, because IMAP capabilities are
  discovered and cached and the endpoint reads only the cache. `lanes link connect icloud_mail`
  reuses the stored credential, so it is non-interactive. Between refreshing the cache and
  restarting the endpoint there is a window where the old code advertises `attachments` and drops
  it — a mail claiming an attachment it does not have. `plan` cannot warn about this: it diffs
  capability names, and what changed here is a schema. That gap is worth closing separately.
- Reading an attachment still returns metadata only. That gap is unchanged and now asymmetric:
  sending bytes works, receiving them still costs a base64 round trip through the model. Closing it
  means a `stage: true` mode on the byte-producing read tools, which would let
  `drive_file_id`-style cross-provider sources work by staging rather than by reaching another
  connection's credential. Not taken here.

## Alternatives rejected

- **Raising a size limit.** There was none to raise; see Context.
- **Chunked base64 across several tool calls.** Solves the per-message ceiling and not the token
  cost, which is the actual expense.
- **`drive_file_id` as a direct source.** Gmail has no reference-attachment mechanism — the Drive
  chip is a web-UI feature — so it means download-and-re-attach, and the bytes resolve against the
  *Drive* connection's credential. Doing it from a Gmail handler would need either dispatch
  reentrancy or a hole in the connection boundary. Staging covers the case today.
- **MCP `roots`.** Transfers no bytes, names paths on the client's host, deprecated, and
  unimplemented by the two clients that matter.
