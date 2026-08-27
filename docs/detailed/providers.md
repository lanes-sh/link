# Providers

Capabilities shipped today, and why each is a tool, a resource, or a prompt
([ADR-006](adr/006-tools-resources-prompts.md)).

## `example`

No external service, no credentials, no browser. Ships as the provider SDK reference and as the way
to exercise connection isolation without any accounts — and it is an **owner provider in miniature**,
the same shape memory, skills, and vault take.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `example.echo` | tool | read | An action with a parameter. Names the connection it reached, which makes routing visible. |
| `example.get_note` | tool | read | A parameterised query. The resource below covers addressed retrieval; this covers "fetch by key" in a tool-shaped flow. |
| `example.list_notes` | tool | read | Enumeration is a query, not a document. |
| `example.set_note` | tool | write | An action with a side effect. |
| `example.delete_note` | tool | write | Likewise. |
| `example://note/{key}` | **resource** | read | Read-oriented context addressed by a stable identifier — exactly what resources are for. |

**Redaction:** `echo` records its `message`, because the message *is* the whole payload and recording
it is what makes the audit log useful here. `set_note` and `get_note` record the `key` and never the
`value` — the key is a useful, harmless identifier; the value is content. A provider handling real
correspondence would record neither.

`example.set_note` and `example.delete_note` are in the `write` bundle, which is **not** granted by
default. `lanes link connect example` grants `read` only, so a fresh profile can read and echo but not
modify — the smallest demonstration that bundles do something.

## `gmail`

Setup: [`setup/google.md`](setup/google.md). By default this authorises against the Google OAuth
client Lanes operates, whose secret stays in the Lanes API and never reaches your machine;
`--own-client` registers one of your own instead. [ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md)
records what each path trades.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `gmail.users.messages.list` / `.get` | tool | read | Search over Gmail's own `q` syntax, then retrieval by id. A message id is discovered *through* search rather than being a stable address, so a tool rather than a resource. |
| `gmail.users.threads.list` / `.get` | tool | read | Same reasoning; a thread is assembled, not addressed. |
| `gmail.users.messages.attachments.get` | tool | read | By id, returning the bytes. |
| `gmail.users.labels.list` / `.get` | tool | read | Enumeration is a query, and this is where the label ids come from. |
| `gmail.users.drafts.list` / `.get` | tool | read | |
| `gmail.users.getProfile` | tool | read | The address this connection belongs to. |
| `gmail.send_message` | tool | write | **Authored, not generated** — see ADR-017. The only way to create *or* revise a draft: `draft_only: true` writes one, `draft_id` replaces one. Both generated alternatives made the caller assemble a base64url MIME body, which no model can do for an attachment. Not idempotent, and its description says so. |
| `gmail.users.drafts.send` / `.delete` | tool | write | Send or discard one that exists. Nothing else writes a draft. |
| `gmail.users.messages.modify` / `.batchModify` | tool | write | **Read-state, archiving, spam, and folders are all this one operation.** Gmail has no separate verb: unread is `addLabelIds: ["UNREAD"]`, archive is `removeLabelIds: ["INBOX"]`, spam is `addLabelIds: ["SPAM"]`, and moving to a folder is adding that folder's label id — a Gmail folder *is* a label. |
| `gmail.users.threads.modify` | tool | write | The same, across every message in a thread. |
| `gmail.users.messages.trash` / `.untrash` | tool | write | Recoverable. There is no permanent delete here: that needs `mail.google.com`, the one scope this refuses. |
| `gmail.users.threads.trash` / `.untrash` | tool | write | |
| `gmail.users.labels.create` / `.update` / `.delete` | tool | write | The label vocabulary itself — which is to say, the folders. |
| `gmail.users.settings.filters.list` | tool | read | What standing rules already exist. Free: it accepts `gmail.readonly`. |
| `gmail.users.settings.filters.create` / `.delete` | tool | write | **Blocking a sender.** Distinct from reporting spam, which is the label edit above. A filter is a standing rule acting on mail that has not arrived yet, and it keeps running after the token expires and after the connection is disabled — `lanes link policy deny` removes the tool and cannot remove the rule. Needs `gmail.settings.basic`, which is why it is the only capability here costing a re-consent. |

Because the label ids *are* the feature and nothing in a generated description says so, the three
`modify` tools and `filters.create` carry a **hint** — prose appended to the vendor's own
description, declared in `providers/google/gmail/hints.ts`. This is not decoration: all four of
"mark unread", "move out of the inbox", "report spam", and "move to a folder" were reachable for
months and read as missing, because a tool called `gmail_users_messages_modify` taking a free-form
`addLabelIds` array does not look like the answer to any of them.


**Redaction is the interesting part here.** `messages.list` records **nothing** — not even `q`.
`from:hr@example.com subject:redundancy` is precisely the content the caller may not have been
allowed to read, and a search term is frequently more revealing than the result. `messages.get` and
`threads.get` record their `id`, because an audit log that cannot say *which* message was read
answers very little, and an opaque id discloses nothing on its own. The organising tools keep their
label ids, so a write log can say what was archived and what was marked spam.

`send_message` keeps nothing at all — the recipients and the body *are* the message, and
`attachments` is an argument that may literally contain a file. What was attached is recorded
instead through `audit.annotate`: filename, size, type, SHA-256, and where the bytes came from.

`filters.create` is the one deliberate exception, and it is the `drive.permissions.create` call
again: `criteria` is kept, because a log saying a filter was installed but not against whom has
failed at the only question it exists to answer. The cost, stated rather than hidden — `criteria`
also carries `query` and `subject`, so a filter built on words instead of a sender logs those words.
The tiebreak is durability: a search is a question asked once, a filter is a rule that outlives the
credential, and this log is then the only record of who installed it.

Access tokens are derived from refresh tokens and cached **in memory only, never persisted** — they
are short-lived by design, and storing one would create a second credential to protect for no
benefit. The cache is keyed per connection, so two accounts never share a token.

The server acts as its own OAuth client to Google and **never forwards an incoming bearer token
upstream** — the confused-deputy rule. That token authenticates a caller to *this* endpoint and has
no meaning at Google; structurally it never reaches provider code at all.

## `drive`

Setup: [`setup/google.md`](setup/google.md) — the same OAuth client as Gmail.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `drive.about.get` | tool | read | Quota and the account's own address. |
| `drive.files.list` / `.get` | tool | read | Search and metadata. |
| `drive.files.export` | tool | read | A Google-native file rendered to a portable format, since its bytes are not downloadable. |
| `drive.permissions.list` | tool | read | Who a file is shared with. |
| `drive.files.create` | tool | write | **Also how every Google-native file is created**: `mimeType: "application/vnd.google-apps.spreadsheet"`, `.document`, `.presentation`, or `.folder`. Sheets and Docs have no create tool, so this is it. |
| `drive.files.update` | tool | write | **Also how a file is moved, renamed, and deleted.** Moving is `addParents`/`removeParents`, because a Drive file has no path, only parents. Deleting is `trashed: true`, which is recoverable. |
| `drive.files.copy` | tool | write | |
| `drive.permissions.create` | tool | write | Sharing. |

`files.delete` is deliberately absent: it is permanent, and Drive has a trash, so
`files.update` with `trashed: true` is the recoverable form of the same intent — the same reasoning
that keeps `messages.delete` out of Gmail. `permissions.update` and `permissions.delete` are absent
too, on a different ground: they would let an agent revoke access it did not grant, including
somebody else's.

Both write paths carry a **hint** saying so, for the same reason Gmail's do — `drive_files_update`
does not read like the answer to "move this file" or "delete this file", and both were reachable
long before anyone found them.

**Scope:** `drive.readonly` and `drive.file`. Every write above is bounded by `drive.file` to files
this app created — that bound is why there is no rename-anything tool, since `drive.file`'s other
half is files the user picks through a Google Picker, and there is no picker on an MCP endpoint.
Neither scope is `auth/drive`, which is refused.

**Redaction:** identifiers and shape, never the user's words. `files.create` keeps `mimeType` and
`parents` and withholds `name`; `files.update` keeps `fileId`, the parent moves, `trashed`, and
`starred`. `permissions.create` keeps `emailAddress` — an access log that can say a file was shared
with somebody as a writer but not with whom has failed at its one question.

## Sheets and Docs — `sheets`, `docs`

These exist because Drive cannot edit a file. Drive holds a spreadsheet and can export a rendering
of it, but nothing in Drive writes a cell — the nearest thing, `files.update` with media, replaces
the whole file through import conversion and discards formulas, formatting, tabs, and comments on
the way. Cell-level editing lives in the Sheets API and paragraph-level editing in the Docs API, so
reaching them means talking to them.

Setup: [`setup/google.md`](setup/google.md) — same OAuth client as Gmail and Drive, and the Drive
API must be enabled for these two as well, because that is how a connection learns its own address.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `sheets.spreadsheets.get` | tool | read | Structure — tabs, named ranges, dimensions — without the cells. |
| `sheets.spreadsheets.values.get` | tool | read | One A1 range. The ordinary read. |
| `sheets.spreadsheets.values.batchGet` | tool | read | Several ranges in one call, which is one round trip instead of five. |
| `sheets.spreadsheets.values.update` | tool | write | Write cells to a range. |
| `sheets.spreadsheets.values.batchUpdate` | tool | write | The same across ranges, atomically. |
| `sheets.spreadsheets.values.append` | tool | write | Add rows after the last one, without first reading to find out where that is. |
| `sheets.spreadsheets.values.clear` | tool | write | Empty a range. Distinct from writing blanks, which leaves formatting behind. |
| `sheets.spreadsheets.values.batchClear` | tool | write | Empty several ranges at once — one audit event naming all of them, rather than one per range. |
| `sheets.spreadsheets.sheets.copyTo` | tool | write | Copy a tab into a *different* spreadsheet. `batchUpdate`'s `duplicateSheet` cannot cross a file boundary and `drive.files.copy` copies the whole file, so nothing else reaches this. |
| `sheets.spreadsheets.batchUpdate` | tool | write | Everything structural: tabs, formatting, frozen rows, charts, conditional formats. |
| `docs.documents.get` | tool | read | The document as a structure. Reading it is how you find the index to edit at. |
| `docs.documents.batchUpdate` | tool | write | Every document edit there is; Docs has no `values`-style shortcut. |

Neither `spreadsheets.create` nor `documents.create` is offered, and the reason is measured rather
than asserted. `drive.files.create` already makes an empty Google-native file by `mimeType`, so they
would be a second way to do one thing — and their request bodies are whole `Spreadsheet` and
`Document` objects. Generated, `spreadsheets.create` is a **1,133KB** input schema against a 64KB
budget; `documents.create` is 98KB. Making `Sheet` opaque brings the first to 80.7KB, still over,
and the only configuration that fits also hides `SpreadsheetProperties` — at which point the tool
cannot describe `title` and tells an agent nothing.

**So: to create a spreadsheet, call `drive.files.create` with
`mimeType: "application/vnd.google-apps.spreadsheet"`, then write into it with the `values` tools.**
That sentence is now also carried on the tools themselves, as a hint on `sheets.spreadsheets.get`
and `sheets.spreadsheets.batchUpdate` — "sheet has no create" is the reasonable conclusion from
reading a tool list, and the fix for it is the tool list saying otherwise.

**The two `batchUpdate` tools take their `requests` as open objects**, described rather than
schematised. This is not laziness: `mcp-from-openapi` inlines `$ref`s, and Sheets' `Request` is a
union of some eighty variants sharing sub-schemas that inlining duplicates per occurrence. Expanded,
it generates a **2,469KB** input schema — against 45KB for the whole of Drive — and it would be sent
on every `tools/list`. Opaque, it costs 3KB and keeps the operation. `src/cli/tools.test.ts`
holds a per-tool size budget so the next one fails loudly instead of quietly.

**Redaction:** identifiers and shape are recorded, contents never. `spreadsheetId`, `documentId`,
the A1 `range`, and the write mode are kept, because a write log that cannot say *which* file
changed and *where* answers nothing. `values`, `data`, and `requests` are withheld — those are the
spreadsheet and the document. Reads are recorded here where Gmail withholds its own, and the
difference is real rather than an inconsistency: Gmail's `search` carries a query, and the question
is often more revealing than the answer, whereas a Sheets read carries a file id and a range.

**Scope:** these ask for `spreadsheets` and `documents` respectively, which `lanes link connect`
marks broad. Every operation above is satisfied by `drive.file`, which is already granted — but
`drive.file` means files this app created, its other half needs a Picker no MCP endpoint has, and so
without the broader scope an agent can maintain its own spreadsheets and cannot open yours. Neither
scope grants `auth/drive`; anything that is not a spreadsheet or a document stays read-only.

## Calendar, Tasks, and Contacts — `calendar`, `tasks`, `contacts`

The three that make an assistant useful for ordinary days rather than only for mail and files.
Setup: [`setup/google.md`](setup/google.md) — the same OAuth client again, and each needs its own
API enabled and its own scopes registered.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `calendar.calendarList.list` | tool | read | Which calendars exist, and the primary one's time zone. |
| `calendar.events.list` | tool | read | The ordinary read: a window, or a query. |
| `calendar.events.get` | tool | read | One event, by id. |
| `calendar.events.instances` | tool | read | The occurrences of a recurring event, which `list` does not expand unless asked. |
| `calendar.freebusy.query` | tool | read | "When am I free" as one call, across calendars whose contents the token may not read. |
| `calendar.events.insert` | tool | write | Create an event. |
| `calendar.events.patch` | tool | write | Change one, field by field — see below for why there is no PUT. |
| `calendar.events.delete` | tool | write | Cancel one. |
| `calendar.events.move` | tool | write | Move an event to another calendar, which is not expressible as a patch. |
| `tasks.tasklists.list` | tool | read | Which lists exist. |
| `tasks.tasks.list` | tool | read | The tasks in one, with the filters that make "what is due" answerable. |
| `tasks.tasks.get` | tool | read | One task. |
| `tasks.tasklists.insert` / `.patch` | tool | write | Make a list, rename one. |
| `tasks.tasks.insert` / `.patch` / `.delete` | tool | write | The ordinary lifecycle. Completing a task is `patch` with a status. |
| `tasks.tasks.move` | tool | write | Reorder, or re-parent into a subtask. |
| `people.people.searchContacts` | tool | read | A name in, an address out. The reason this provider exists. |
| `people.otherContacts.search` | tool | read | The same over addresses Gmail saved automatically but you never did. |
| `people.people.getBatchGet` | tool | read | Several contacts by resource name, once search has found them. |

**No PUT anywhere.** Calendar and Tasks both offer `update` beside `patch`, and only `patch` is
vendored. This is the inverse of the `labels.patch` case in Gmail, where two operations did the same
thing and the redundant one was dropped: here they differ, and the difference destroys data. PUT
replaces the resource, so an agent that reads an event, edits the title, and sends it back drops
everything it did not echo — attendees, reminders, recurrence, conferencing.

**Nothing destroys a container.** `tasklists.delete` would take every task in the list with it and
Tasks has no trash, so it is not offered; the same reasoning keeps `calendars.delete` and the rest
of the whole-calendar operations out, which also happen to require the one Calendar scope this
provider refuses.

**Contacts is read-only and cannot enumerate.** There is no "list all my contacts" and no "get this
one person", and the reason is mechanical rather than a policy choice. Google describes those paths
with a reserved-expansion placeholder — `v1/{+resourceName}` — whose value always contains a slash
(`people/me`). The OpenAPI conversion drops the `+`, and the generated tool percent-encodes the
value as a single path segment, so the request goes out as `/v1/people%2Fme` and Google's frontend
answers 404 with an HTML page. Both operations would list fine, pass policy, and fail every call, so
neither is vendored. Searching is the route that works, and it is the one an assistant actually
wants: "email Bob" is a name, not a resource name.

**Redaction:** identifiers and shape, never content. Calendar keeps `calendarId`, `eventId`, the
time bounds, and `sendUpdates` — cancelling a meeting quietly and cancelling it with mail to
everyone invited are different acts, and only that flag tells them apart. It withholds `summary`,
`description`, `location`, and `attendees`, which are the meeting. Tasks keeps `due` and `status`
and withholds `title` and `notes`. Contacts withholds `query` throughout, on the same ground Gmail
withholds a search: the name someone looked up is content. `freebusy.query` is the one call where a
kept-looking argument is withheld — its `items` list is a set of *people you asked about*, which is
the question rather than the subject.

**Scope:** `calendar.events` and `tasks` are marked broad and both are argued for in
[`setup/google.md`](setup/google.md#4-data-access). `calendar.events` reaches every event on every
calendar but no calendar itself; `tasks` is the only scope Google publishes for Tasks that can
write at all. `contacts` asks for nothing broad — both of its scopes are read-only, and the write
scope permanently deletes. None of the three grants `auth/calendar` or `contacts`.

## `reddit`

Fifteen operations against Reddit's REST API. Setup: [`setup/reddit.md`](setup/reddit.md) — the one
provider that needs an OAuth client of your own, because Reddit rate-limits per client id and a
shared one would pool every install into a single hundred-per-minute budget.

The spec at `src/providers/reddit/specs/reddit.v1.json` is **hand-authored**: Reddit publishes no
OpenAPI document, so unlike the Google specs there is no vendoring script and no upstream to
re-sync from. It is still a document rather than code — the operations become capabilities
mechanically, and there is no per-endpoint translation anywhere in the folder.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `reddit.list_posts` | tool | read | Posts from one subreddit, in a given order. The ordinary read. |
| `reddit.get_post` | tool | read | One post with its comment tree. Takes the base36 id, not the fullname. |
| `reddit.search` | tool | read | Full-text search within a subreddit. |
| `reddit.get_subreddit` | tool | read | Description, subscriber count, and whether posting needs a flair. |
| `reddit.get_rules` | tool | read | What a submission must satisfy. Most removals are rule violations, not API errors. |
| `reddit.list_flairs` | tool | read | Flair templates and their ids — the thing `submit_post` usually needs first. |
| `reddit.whoami` | tool | read | Which account this connection is. Also what `identity` resolves the label from. |
| `reddit.list_my_subreddits` | tool | read | The subreddits this account subscribes to. |
| `reddit.submit_post` | tool | write | Create a text or link post. |
| `reddit.add_comment` | tool | write | Comment on a post, or reply to a comment. |
| `reddit.edit_text` | tool | write | Replace the body of something this account wrote. |
| `reddit.vote` | tool | write | Up, down, or clear. |
| `reddit.delete_thing` | tool | write | Permanent — Reddit has no trash reachable from the API. |
| `reddit.save_thing` | tool | write | Add to saved items. |
| `reddit.set_flair` | tool | write | Apply a flair template to your own post. |

**No moderation, no messages, no history.** Reddit publishes thirty scopes and this asks for eight.
`privatemessages` would put the account's DMs in reach of a tool list whose subject is public
posting; the `mod*` scopes act on other people's content in subreddits this account moderates,
which is a different job with a different blast radius. Nothing here needs either, and a scope on
the consent screen that no tool can spend is a grant asked for and never noticed.

**Two things the tool descriptions say twice**, because an agent gets both wrong on the first
attempt and the error does not explain either. `add_comment` takes a *fullname* — `t3_<id>` for a
post, `t1_<id>` for a comment — and a bare id from a URL is rejected generically. And most
subreddits reject a submission with no `flair_id` without saying that a flair was the problem,
which is why `list_flairs` is vendored beside `submit_post`. Both are also in `hints`.

**Scope:** `submit`, `edit`, and `vote` are marked broad, and for a different reason from every
other broad scope here. The rest are broad for how far they reach into a private space; these are
broad for acting *publicly* under the person's username. They are also the only writes in this
repository that cannot be taken back — deleting a post leaves the deletion behind, and anything
quoted or replied to in the meantime stays. `read` is not marked: it reaches only what the account
can already see, and what Reddit makes readable is public to begin with.

**Redaction** follows Gmail's line, with one addition worth naming: `title` is withheld along with
the body. It looks like metadata and is not — a Reddit title is usually the whole of the post and
the body is often empty, so keeping it would defeat withholding the body. For a link post the
`url` is the submission, so that is withheld too. What survives is where it went and how it was
marked: `sr`, `flair_id`, `nsfw`, `spoiler`.

## `discord`

Twenty operations against Discord's v10 REST API. Setup:
[`setup/discord.md`](setup/discord.md) — an application you create, whose bot token you paste, and
which you invite to each server you want reachable.

The spec at `src/providers/discord/specs/discord.v10.json` is vendored by
`src/providers/discord/specs/vendor.ts` from the OpenAPI document Discord publishes. Vendoring
matters more here than for Google: upstream is a public preview Discord says may change without
notice, so the committed copy is what stops a breaking change upstream becoming a provider that
stops working.

**Discord has no API for acting as your own account.** Automating a user token is self-botting,
which their terms forbid, and the OAuth2 user scopes cover neither posting nor reading channel
history. So every message here is sent by an *application* and carries an `APP` badge that no
setting removes. The name and avatar are controllable — per message, through a webhook — which is
why the three webhook operations are vendored. ADR-047 has the whole argument.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `discord.get_my_user` | tool | read | Which application this token is. The cheap call that proves the `Bot ` prefix landed. |
| `discord.list_my_guilds` | tool | read | The servers the bot was added to — not the ones you are in. An empty list means the invite was missed. |
| `discord.get_guild` | tool | read | One server, with optional member counts. |
| `discord.list_guild_channels` | tool | read | How a channel *name* becomes the id every other call needs. `type` says whether it can take messages. |
| `discord.get_channel` | tool | read | One channel — name, type, topic, category. |
| `discord.list_messages` | tool | read | The triage read, and the only one: Discord offers applications no message search. Pages on `before`/`after`. |
| `discord.get_message` | tool | read | One message in full, with reactions and embeds. |
| `discord.list_pins` | tool | read | What has been marked. The current endpoint, not the deprecated one. |
| `discord.list_message_reactions_by_emoji` | tool | read | Who reacted with one emoji — a lightweight vote, read back. |
| `discord.get_active_guild_threads` | tool | read | Every open thread in a server at once, cheaper than walking channels. |
| `discord.create_message` | tool | write | Post as the application. `embeds` rather than `content` is what makes an announcement. |
| `discord.update_message` | tool | write | Edit its own message. The typo fix; Discord shows an "edited" marker regardless. |
| `discord.delete_message` | tool | write | The retraction. One message by id — there is deliberately no bulk delete. |
| `discord.crosspost_message` | tool | write | Publish an announcement-channel post to the servers that follow it. `type: 5` channels only. |
| `discord.add_my_message_reaction` | tool | write | Mark a message seen or triaged. Notifies nobody. |
| `discord.create_pin` | tool | write | The heavier mark. Needs Manage Messages; 50 per channel. |
| `discord.create_thread_from_message` | tool | write | Turn a post into a discussion without cluttering the channel. |
| `discord.list_channel_webhooks` | tool | read | Find an existing webhook before making another. Returns tokens — see below. |
| `discord.create_webhook` | tool | write | One per channel, once. Returns a token — see below. |
| `discord.execute_webhook` | tool | write | Post with `username` and `avatar_url` set per message. How an announcement reads as you. |

**The vendored list is the security boundary, not a convenience.** `connect` writes one rule,
`discord.*`, and policy has nothing between a whole provider and one exact name — so twenty of
Discord's 242 operations is the whole of what an agent can reach. `bulk_delete_messages` is
excluded although it sits beside `delete_message`; so is every moderation, role, invite and
guild-settings endpoint. `discord.test.ts` asserts the list is exactly those twenty, so a spec
refresh that picks one up fails and gets read rather than merging quietly.

**Two operations return a credential.** `create_webhook` and `list_channel_webhooks` include the
webhook's token in their response, and a webhook token is standalone — anybody holding it posts to
that channel with no other authentication. It therefore reaches the model. Recorded as
`provider.response-may-carry-a-credential` in [`security.md`](security.md) rather than glossed
over, and accepted because the alternative is not the same capability made safe but no posting
under the operator's own name at all.

**No scopes**, because there is no OAuth. What the token can do is chosen by the permission bits on
the invite URL, in Discord's own console, and this endpoint cannot read them back — the same
narrower guarantee every pasted-token provider has. The setup page prints an invite URL carrying
exactly the bits the twenty operations need and nothing else.

**Reading needs the Message Content intent**, a toggle in the developer portal that is free for an
application under 10,000 users. Without it `list_messages` returns `200` with every `content`
empty, and nothing in the response says why. It is called out in the walkthrough, in
`troubleshooting`, and in the `list_messages` hint.

**Every operation carries a hint**, which is unusual and not decoration: Discord describes 17 of
its 242 operations and none of the twenty here, so `mcp-from-openapi` synthesises
`POST /channels/{channel_id}/messages` and the hint is the entire rest of what an agent reads.
Hinting all twenty also turns `cli/tools.test.ts` into a completeness check, since it resolves each
hint against a generated capability by name.

**Redaction** keeps ids and cursors and withholds message bodies, with two deliberate exceptions.
`allowed_mentions` is kept everywhere something posts: it is not content but blast radius, and
whether a post could ping `@everyone` is unrecoverable once the message is edited. `username` is
kept on `execute_webhook`, because the post is deliberately wearing a name that is not the
application's and *posted as "Ops" in channel 123* is the entry's whole point. `webhook_token`
beside it is withheld, and a test asserts no capability keeps it.

**Attachments are unavailable.** Discord takes files as `multipart/form-data`; the connector
encodes JSON and form-urlencoded (ADR-045) and the multipart branches are dropped during vendoring,
because their fields are named `files[0]` and one illegal property name rejects the entire tools
list for every provider on the endpoint.

## iCloud — `icloud_mail`, `icloud_calendar`, `icloud_contacts`

One Apple Account, three providers, one app-specific password
([setup](setup/icloud.md), [ADR-010](adr/010-non-http-connectors.md)). Three
rather than one because mail is IMAP and calendars are CalDAV — different
protocols, and a manifest has one connector — and because a policy line per
provider is what lets someone allow `icloud_calendar.*` while never granting
mail.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `icloud_mail.list_mailboxes` | tool | read | Enumeration is a query. Reports each folder's special-use flags, since the *names* are localised. |
| `icloud_mail.search_messages` | tool | read | A parameterised query, returning envelopes rather than bodies. |
| `icloud_mail.get_message` | tool | read | Assembled from a UID, not addressed by a stable URI — a tool, not a resource. |
| `icloud_mail.mark_messages` | tool | write | Changes what you see in Mail, so it is a write even though it destroys nothing. |
| `icloud_mail.move_messages` | tool | write | Archiving, filing, and reporting junk. Takes either an exact `destination` or a `destination_flag` — an RFC 6154 attribute like `\Junk`, resolved against what the server advertises, because the *names* are localised. Exactly one of the two, refused rather than resolved by precedence. Offered only where the server advertises `MOVE`; never emulated with copy-and-delete. |
| `icloud_mail.send_message` | tool | write | Files a copy in the `\Sent`-flagged mailbox. |
| `icloud_calendar.list_calendars` | tool | read | Filters out Reminders lists, which iCloud publishes as CalDAV collections holding `VTODO`. |
| `icloud_calendar.list_events` | tool | read | The server expands recurrences; if one declines, the result says `expanded: false` rather than guessing. |
| `icloud_calendar.get_event` | tool | read | By UID, with the raw iCalendar on request. |
| `icloud_calendar.create_event` | tool | write | `If-None-Match: *`, so a UID collision is refused rather than overwriting. |
| `icloud_calendar.update_event` | tool | write | Patches the existing entry, so attendees, alarms and repetition survive; `If-Match` on the ETag turns a lost update into a refusal. |
| `icloud_calendar.delete_event` | tool | write | Also `If-Match`. Goes to the calendar's trash, not permanently. |
| `icloud_contacts.list_addressbooks` | tool | read | Enumeration. |
| `icloud_contacts.search_contacts` | tool | read | A parameterised query. |
| `icloud_drive.list_files` | tool | read | Enumeration. Reports whether each file is downloaded, since iCloud evicts. |
| `icloud_drive.search_files` | tool | read | By name, and optionally by the text inside. |
| `icloud_drive.read_file` | tool | read | Text only; a binary reports its type and size rather than returning noise. |
| `icloud_drive.file_info` | tool | read | Size, timestamps, download state. |
| `icloud_drive.write_file` | tool | write | Refuses to replace an existing file unless told to. |
| `icloud_drive.move_file` | tool | write | Within the root, and refuses to clobber the destination. |
| `icloud_drive.create_folder` | tool | write | |
| `icloud_drive.trash_file` | tool | write | To the Finder's Trash. There is no permanent delete. |
| `icloud_contacts.create_contact` | tool | write | A fresh vCard, so there is no round-trip to lose fields in. Editing an existing card is deliberately not offered — see below. |

**Reading never marks mail read.** Every read path uses `EXAMINE` rather than
`SELECT` and `BODY.PEEK[]` rather than `BODY[]`. Setting `\Seen` is reachable
only through `mark_messages`, in the write bundle — never as an argument to a read
capability, because an argument that flips a capability's bundle defeats the
split the policy is expressed in.

**Nothing here can destroy mail.** No `EXPUNGE`, and `\Deleted` is not a settable
flag. Moving to Trash is available and reversible; permanent deletion is not
offered.

**Redaction** follows Gmail's reasoning. `search_messages` records the mailbox
and the limit but never `from`, `to`, `subject`, or `text`: a search term is
frequently more revealing than the result. `send_message` records **nothing** —
the recipients and the body *are* the message. `search_contacts` records the
address book but not the query, for the same reason: a name is content.

**iCloud Drive is a folder, not a protocol** ([ADR-011](adr/011-local-filesystem.md)).
Apple publishes no API for it; on a Mac it is a synced directory, so the `fs`
connector reads it directly and there is no credential at all. That means it only
works on the machine holding the files — a cloud deployment reaches it by
relaying to a local instance, which is M3's problem. Paths are resolved through
symlinks before being checked against the root, because on a Mac with Desktop and
Documents syncing, that root is very nearly everything its owner has.

**Editing a contact is not offered.** vCard round-trip fidelity is where data
gets destroyed — photos, `X-` properties, iCloud's own 3.0 quirks — and losing a
field from someone's contact card is both silent and permanent. Creating and
searching carry no such risk.

Not available, and not a limitation of this implementation: **Reminders and
Notes** (Apple moved to-do lists to a private store after iOS 13; Notes were
never exposed) and **iCloud Drive** (no public API).

Attachments are asymmetric, and worth stating plainly. **Sending** them works —
`send_message` takes an `attachments` list and this endpoint fetches the bytes
itself (ADR-017). **Reading** them still does not: `get_message` reports each
attachment's name, type, and size but not its content, so forwarding one is done
by naming it (`message_id`) rather than by reading it first.

## Attachments

`gmail.send_message` and `icloud_mail.send_message` both take an `attachments` list. **The bytes
never pass through the model** — a file is *named*, and the endpoint reads it. That is the whole
design, and ADR-017 has the reasoning; what follows is how to use it.

Each entry carries **exactly one** source. Two is an error rather than a precedence rule, because
silently preferring one would make the other look like it worked.

```jsonc
{ "path": "/Users/you/Downloads/invoice.pdf" }        // read from this machine
{ "url": "https://example.com/invoice.pdf" }          // fetched here, over HTTPS only
{ "handle": "att_01j7k…" }                            // staged earlier, see below
{ "message_id": "18f…", "attachment_id": "quote.pdf" } // already in this mailbox
{ "data": "JVBERi0…", "filename": "invoice.pdf" }     // inline base64 — last resort
```

`filename` and `content_type` are optional overrides on any of them. `attachment_id` may be a
filename, a 1-based position, or (on Gmail) the vendor's own id; omit it when the message has one
attachment.

**Forwarding costs nothing.** `message_id` resolves inside the endpoint, so re-sending a PDF that
arrived by mail never materialises it anywhere a context window can see. Prefer it over reading an
attachment and passing the bytes back — the read side still returns metadata only, so that route
does not exist anyway.

**Sending from a remote endpoint.** `path` means the filesystem the *server* can see, which on Cloud
Run is a container. Stage the bytes instead:

```console
$ lanes link attach ~/Downloads/invoice.pdf --connection gmail.you
att_75f5be471a18b0f7…  invoice.pdf  239104 bytes
```

or `POST /attachments?connection=gmail.you` with the file as the body, an `X-Filename` header, and
the usual bearer token. Either way you get a handle to pass as `{ "handle": "…" }`. Handles belong to
the connection they were staged for, expire after a day, and are swept on the next upload.

**What the log keeps.** Recipients and bodies are withheld, as before. Per attachment it records the
filename, byte length, content type, SHA-256, and where the bytes came from — including the resolved
absolute path. `path` is deliberately unrestricted, so that record is the only trace of which file
left the machine; it is what makes "was this ever mailed out" an answerable question. The tool result
is the same receipt, never the content.

**An existing iCloud connection needs re-connecting once.** IMAP capabilities are *discovered*
and cached in the profile database, and the endpoint only ever reads that cache — so a connection
made before this change keeps the old schema and `attachments` never appears, however new the code
is. `lanes link connect icloud_mail` fixes it: the stored app password is reused, so it is
non-interactive. Gmail needs nothing, because its send is authored rather than discovered.

Note the failure mode in between: an endpoint still running the *old* code advertises `attachments`
and silently ignores it — a mail that says it has an attachment and does not, which is the original
bug wearing a new hat. The refreshed cache reaches a running endpoint on its own, because `connect`
asks it to re-read (ADR-029); the old *code* does not, and that is what a deploy is for.
`lanes link plan` will not warn you, because it compares capability *names* and this changed a
schema.

### The `From` header, and what it has to do with spam

Give a connection a display name or recipients see a bare address:

```yaml
connections:
  - id: rin_shaw
    provider: icloud_mail
    account: rin.shaw@example.com
    config:
      from_name: Ada Lovelace
```

`from_name` on the call overrides it; with neither, the header stays a bare
address rather than a guessed name.

**Only the SMTP path needs this.** Gmail is asked for no `From` at all, so it fills the header from
the credential — display name included — which is better than anything guessable here. SMTP submits
exactly what is composed and has no such step, so before this an iCloud send read
`From: rin.shaw@example.com`.

**It is not a spam control.** What decides placement is alignment, and that was already healthy: a
message sent this way arrives `dkim=pass header.i=@icloud.com` and `spf=pass`, signed and sent by
iCloud's own infrastructure, because the endpoint submits through the account rather than spoofing
it. A missing display name is a *trust* problem, not a deliverability one — it makes correspondence
look machine-generated to the person reading it, which for client-facing mail is reason enough.

**Size.** Gmail accepts 35 MiB and iCloud 20 MB, both counted *encoded* — attachments travel base64,
so usable file weight is about three quarters of that. Oversized sends are refused before anything
is submitted, since a message rejected part-way through `DATA` reads like a dropped connection.

## The owner layer — `memory`, `skills`, `vault`

Three providers holding no third-party account: no OAuth, no vendor API, no rate limit anyone else
imposes. They are the reason the resource and prompt primitives exist, and the decisions behind their
shapes are [ADR-012](adr/012-owner-layer-primitives.md) and
[ADR-014](adr/014-owner-layer-is-managed.md).

Their ids stay **reserved**: `RESERVED_PROVIDER_IDS` still refuses `memory`, `skills`, and `vault`
everywhere except the one built-in registry that registers them. The guard was never about the layer
being unbuilt — reclaiming a namespace once providers exist in the wild would silently change what a
policy rule means.

**All three have a CLI**, and it reaches the same bytes the providers do — `lanes link memory`, `lanes link skills`,
`lanes link vault`. That is not a convenience: without it the two stores holding your own data were reachable
only by an agent, which is the wrong way round for a project whose README says control-plane decisions
are not agent-reachable.

**All three follow the target.** Memory and skills are Markdown documents in `BlobStore`; the vault is
one encrypted document. Locally that is files under the workspace, and in a deployment the same keys
in S3. Before ADR-014 the vault had no target switch at all, so a Cloud Run instance wrote it to a
container filesystem that the next revision discarded.

**All three are the profile's**, and so is the `providers.d/` beside them — see
[ADR-030](adr/030-a-profile-owns-its-skills-and-manifests.md). Skills were workspace-wide until
then, which made them the one owner-layer store a second profile could read.

| | Local | Cloud | With a `knowledge:` block |
|---|---|---|---|
| skills | `<workspace>/data/<profile>/skills.d/<name>.md` | the same key, in the bucket | `skills/<name>/SKILL.md` in the repository |
| memory | `<storage>/memory/<connection>/entry/<id>.md` | the same key, in the bucket | `memory/<connection>/<id>.md` in the repository |
| vault | `<workspace>/data/<profile>/vault.enc` | one object, `targets.<t>.vault.adapter: blob` | unchanged — a vault is never a repository |

The last column is [ADR-041](adr/041-memory-and-skills-in-a-repository.md), and it moves those two
and only those two. `lanes link knowledge use github --repo <owner/name>` writes it;
`configuration.md` has the block and what it costs.

### `memory`

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `memory://entry/{id}` | **resource** | read | Read-oriented context at a stable address — the case ADR-006 said the distinction would matter for. |
| `memory.get` | tool | read | The same content, for clients that do not read resources. |
| `memory.search` | tool | read | A parameterised query. |
| `memory.write` | tool | **write** | An action, and the one that carries the risk below. |
| `memory.forget` | tool | **write** | Likewise. |

**Why writing is a separate capability.** An injected instruction stored once is re-served to every
future session, including to a different agent. A read-only memory cannot do that, and nothing else
in the system persists model-authored text and serves it back as context. So a read-only agent is a
real configuration — `deny: [memory.write, memory.forget]`, one line. Nothing screens what is
written; this separates the privilege and claims nothing more.

**Storage: one Markdown file per entry.** Title, tags, and `updated_at` are YAML frontmatter above the
body, in the same format a skill uses, and the whole entry is a single blob. There is no index row —
ADR-014 removed the one M4 had, because it bought a cheaper listing with a second copy of the truth
that could disagree with the file it described and that nobody could open in an editor.

Frontmatter is **optional on read**. A plain Markdown file dropped into the directory is an entry
titled after its id, and an edit made in a text editor is what the next `memory.get` returns. The
directory is one you are invited to open; a parser that refused your file would make that invitation
false.

**Listing and search read every entry**, and the audit annotation says how many were scanned. That is
the honest cost of the metadata living inside the document, and it replaces a scan that was already a
full one — `StateRepository` has no prefix query and no index either. At owner scale it is fine. If it
ever has to serve tens of thousands, the fix is a derived cache that can be rebuilt from the files,
never a second source of truth.

**Redaction.** `write` records the title, id, and tags, never the text. `search` records **nothing** —
a memory query is at least as revealing as a mail search, since it asks for the owner's own material.
A resource read records its URI, because an address is a useful, harmless identifier.

### `skills`

Every skill is a **prompt**. A skill is *invoked*, and the discriminator is that its answer depends on
its arguments — a resource is a function of its URI alone. A prompt's messages *become* the
conversation, which is what a procedure wants; a tool result comes back as data the model reasons
about.

A skill is a file in `<workspace>/data/<profile>/skills.d/`, either `name.md` or `name/SKILL.md`, with YAML frontmatter
carrying `description` and optional `arguments`; `{{argument}}` is substituted into the body. An
argument the caller omits leaves its placeholder visible rather than becoming empty — "review the diff
below" with nothing below it is a worse failure than one that names what is missing.

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `skills.<name>` | **prompt** | read | One per skill. Invoking it is the point. |
| `skills.manage.list` | tool | **author** | What exists, with descriptions and arguments. |
| `skills.manage.get` | tool | **author** | The stored document — what to edit before writing it back. |
| `skills.manage.write` | tool | **author** | Create or replace. |
| `skills.manage.remove` | tool | **author** | Delete. |

**Authoring is a separate grant, and ADR-012 §1 used to refuse it outright.** The argument was that a
skill is instructions, so an agent able to author one could persist its own future behaviour.
[ADR-014](adr/014-owner-layer-is-managed.md) keeps the argument and changes the answer to the one
`memory.write` already used: a capability in a non-default bundle. Structural absence read stronger
than it was — a skill file is writable by anything running as the owner, so "no agent can write a
skill" only ever meant "not through the one path that evaluates policy and writes an audit event".

**Reading a skill's body is in the author bundle, not the read one.** That is the half of ADR-012 §1
that stands: MCP clients surface prompts as user-selected, and an agent that could read every skill
could pick its own instructions from the catalogue. An invoke-only profile is offered no management
tool at all.

The tools are namespaced `manage.` because a skill named `write` would otherwise be the capability
`skills.write` twice over. A skill name cannot contain a dot, so `skills.manage.*` can only mean these
four — which also makes `deny: [skills.manage.*]` exact.

**A written skill is a prompt without a restart.** Each skill is its own capability, so the registry
has to catch up: a write through MCP refreshes it directly, and a poll bounded to one listing per
profile every two seconds catches `lanes link skills add` run in another terminal.

Routing is in the arguments (ADR-001, unlike a resource which has nowhere to put it), and both
`profile` and `connection` are optional — they default when there is one candidate and refuse rather
than guess when there is not.

### `vault`

| Capability | Kind | Bundle | Why |
|---|---|---|---|
| `vault.get.<item>` | tool | read | **One capability per stored item.** |
| `vault.put` | tool | **write** | Store or replace an item. |
| `vault.remove` | tool | **write** | Delete one. |

**Tools only, never resources** — resources are listable and cacheable, and both are wrong for
secrets. There is no `vault.list` either: the policy-filtered tool list *is* the listing, and it is
the only one that cannot over-report. An agent granted `vault.get.github_token` cannot discover that
`vault.get.bank_password` exists.

**Per-item policy comes from the name.** `vault.get.github_token` is a pattern the policy engine
already matches literally, and `vault.get.*` already narrows — so per-item control needed no change
to policy evaluation and no argument-aware matching, which `config/schema.ts` warns against by name.
The consequence is deliberate: capabilities are fixed for the life of a process, so **an item written
by `vault.put` is not readable until the endpoint restarts**. A write cannot hand itself a read.

**A separate store and a separate key.** Never `SecretStore` — see the two kinds of secret in
[`security.md`](security.md). Vault items live in their own AES-256-GCM document under
`LANES_LINK_VAULT_KEY`, and the vault provider names the system store nowhere, which is
asserted by a test that reads the source.

**Where the document lands is a target's choice; what is in it is not.** `targets.<t>.vault.adapter`
is `file` (the default) or `blob`. The envelope encrypts the whole document as one, so item *names*
are encrypted alongside their values — which is also why there is no secret-manager adapter: a
secret-per-item mapping would publish those names into a cloud IAM console to buy nothing this does
not already have.

The `blob` adapter **will not mint a key.** The file adapter may, because it has a sibling `.key` file
at mode 0600 that outlives the process. A deployment has no equivalent — a key beside the ciphertext
protects nothing, and a fresh key per revision would make every stored item permanently unreadable
while appearing to work — so `LANES_LINK_VAULT_KEY` is required there. Mint one with
`lanes link vault key generate`, which prints it and stores it nowhere.

**Redaction.** `put` records the item id verbatim and withholds the value entirely — `<withheld>`,
not `<string:40>`, because a secret's length is a real disclosure. A read takes no arguments at all;
the item is named by the capability, which the audit event records. Redaction resolves before the
policy decision, so a denied vault call discloses no more than an allowed one.

## `setup`

A fourth owner-layer provider, and the only one that holds nothing at all: it reads manifests
and reports what is connected. It exists because a client with no shell — Claude Desktop, or
anything reaching a deployed instance — could not otherwise learn what this endpoint reaches,
and an agent that cannot see the answer invents commands instead.

| Capability | Kind | Bundle | Arguments |
|---|---|---|---|
| `setup.overview` | tool | `read` (default) | none |
| `setup.provider` | tool | `read` (default) | `id`, optional `connection` |

**There is no write bundle, and no third capability.** Nothing here writes configuration,
stores a credential, signs in, or changes what is permitted — those stay in `lanes link`, per
[ADR-007]. Whether that leaves the wall intact is argued in [ADR-019]; the short version is
that ADR-007 governs *authorisation*, and describing what setup requires authorises nothing.
`src/providers/setup/provider.test.ts` asserts the capability list holds exactly these two, so
the absence is defended rather than noticed.

**Tools, not resources.** `setup.overview` looks resource-shaped — read-oriented, no
arguments — and is a tool anyway ([ADR-006] says decide per capability). Resources are
registered per (profile, connection) and surfaced by clients as user-attachable context, while
the point here is an agent reaching for it unprompted when someone says "set up Notion". They
are also cacheable, which is wrong for something whose whole subject is what changed.

**What it may report.** Only connections this principal can already reach: `reachable()` is
filtered in `src/cli/runtime/open.ts` by `allowedConnections`, the same function the dispatcher
enforces with. A connection hidden by `deny` reads exactly like one that was never made —
asserted over real HTTP in `src/server/setup-surface.test.ts`, because a surface describing
what is configured would otherwise be an oracle on what is denied.

It reports what a provider *requires* and never whether the value is *satisfied*: that needs
the credential store, and only the CLI asks. It emits prompt labels, never the credential
references they resolve to — the command it hands over asks for each value, so the owner never
needs to know where one is filed.

**Redaction.** `setup.provider` keeps `id` verbatim: a provider id is a name this project
ships rather than the owner's data, and a log that cannot say which provider was asked about
answers very little. `connection` is a label the caller chose and is type-marked with
everything else. `setup.overview` takes no arguments.

**A provider that already has an account is still offered another.** It used to drop out of the
overview entirely once one connection existed, which made "connect a second mailbox" — the
question this surface exists to answer — unanswerable from it. Excluded from that are the
providers with no credential to key on a connection id (`auth.kind === 'none'`), where a second
row would address the same thing the first does — today that is `icloud_drive`, which reads a
synced folder on one Mac rather than an account. Both lists key off the policy-filtered
`connected` set rather than the raw config, so a denied connection still reads as
never-connected.

**Enrolling it.** Like any provider, it needs a connection row and an allow rule —
`allowedConnections` returns nothing for a provider with no connection *before* consulting
policy, so without both the capabilities are silently absent. New profiles ship both, and
`connect` and `deploy` add them to a profile written before the surface existed —
`ensureSetupConnection` in `src/cli/config-edit.ts`, on the CLI side because a deployed
instance may not write its own config ([ADR-007], [ADR-023]). It says so when it fires rather
than widening a policy quietly, and `doctor` reports either half missing.

**Removing it** is `deny: [setup.*]`, not deletion. Deleting the two lines works until the next
`connect` or `deploy`, which puts them back; a deny is what the repair reads and leaves alone.
Denying one capability rather than the surface is a narrowing, and the repair still runs — so
withholding `setup.provider` keeps the overview.

[ADR-006]: adr/006-tools-resources-prompts.md
[ADR-007]: adr/007-control-plane-exclusions.md
[ADR-019]: adr/019-describing-setup-is-not-performing-it.md
[ADR-023]: adr/023-the-workspace-is-not-in-the-image.md
