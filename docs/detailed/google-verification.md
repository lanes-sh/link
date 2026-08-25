# Google verification: what goes in the console

Google Auth Platform → **Data access** refuses a submission until every sensitive and restricted
scope is accounted for: the feature that needs it, what becomes of the data, and **why a narrower
scope will not work**. None of them are settings. They are free text on a console form, and a
submission is rejected on what they say.

This file is that text, kept here rather than only in the form, for three reasons. Verification is
annual, so next year's re-submission starts from what was accepted this year rather than from
memory. A scope and the argument for it change together, and a justification that outlives the
capability it was written for is a request for access the application no longer uses — which is
one of the things reviewers look for. And `specs.test.ts` can then check that this file and the
manifests name the same scopes, which is the only mechanism that keeps the two honest.

Everything below is about the **hosted client** — the one Lanes operates, which
[ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md) made the default. An operator who runs
`lanes link connect <provider> --own-client` registers their own and needs none of this;
[`setup/google.md`](setup/google.md) is that path.

## Where each field lives

The console used to ask three questions of each of the twelve scopes on its own form. It now
groups them — **one box for all seven sensitive scopes together, one box per restricted API
family** — and merges the justification and the intended-data-usage statement into a single
question, capped at **1000 characters**.

| Field | Where | What it has to contain |
|---|---|---|
| How will the scopes be used? | **Your sensitive scopes** — one box, all seven | Per scope: the feature that needs it, and **why a narrower scope will not work** — an explanation naming what would break. Omitting the second half is the common rejection. |
| How will the scopes be used? | **Your restricted scopes** → **Drive scopes** | The same for `drive.readonly`, plus what becomes of the data. |
| How will the scopes be used? | **Your restricted scopes** → **Gmail scopes** | The same for the four Gmail scopes. |
| What features will you use? | A multi-select above each restricted family's box | Google's own categories. Drive: **Drive productivity** alone. Gmail: **Email client** and **Email productivity**. Claiming a category the application does not have is a rejection by itself, so "Select all" is the wrong answer to a question that offers it. |
| Demo video | **Not on this page** — the final submission step | One YouTube URL, unlisted is fine, covering every scope. |

The prompt under each box asks for three things — "why you need these scopes, how you will use
them, and why more limited scopes aren't sufficient" — which is the old justification and the old
intended data usage in one field. Both have to come out of the same 1000 characters.

`openid` and `email` are added on the brokered path at connect time rather than declared in a
manifest, and the console does not list them. Nothing is needed for either.

## The scopes

Thirteen, and this block is what the test reads. Adding a scope to a manifest without adding it
here fails the build, and so does the reverse.

<!-- scopes:begin -->

| Scope | Class | Fields needed |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | restricted | yes |
| `https://www.googleapis.com/auth/gmail.compose` | restricted | yes |
| `https://www.googleapis.com/auth/gmail.modify` | restricted | yes |
| `https://www.googleapis.com/auth/gmail.settings.basic` | restricted | yes |
| `https://www.googleapis.com/auth/drive.readonly` | restricted | yes |
| `https://www.googleapis.com/auth/drive.file` | neither | **none** — not sensitive, not restricted |
| `https://www.googleapis.com/auth/documents` | sensitive | yes |
| `https://www.googleapis.com/auth/spreadsheets` | sensitive | yes |
| `https://www.googleapis.com/auth/calendar.readonly` | sensitive | yes |
| `https://www.googleapis.com/auth/calendar.events` | sensitive | yes |
| `https://www.googleapis.com/auth/tasks` | sensitive | yes |
| `https://www.googleapis.com/auth/contacts.readonly` | sensitive | yes |
| `https://www.googleapis.com/auth/contacts.other.readonly` | sensitive | yes |

<!-- scopes:end -->

The class is the lock column in the console, and it decides one thing beyond the paperwork: the
five restricted scopes are what put a security assessment in question. See
[the assessment](#the-security-assessment-and-the-question-that-decides-it) below.

Two refusals are worth stating in the submission because reviewers look for the opposite. Lanes
Link does not request `https://mail.google.com/`, which is full mailbox access including permanent
deletion, and does not request unrestricted `drive`. Permanent deletion is not offered anywhere:
`messages.delete`, `threads.delete` and `files.delete` are deliberately absent, and trash is the
recoverable form of the same intent.

## What goes in the console today

Three boxes, three texts, each measured against the 1000-character cap and each carrying all three
of the things the prompt asks for. This is what is pasted. Everything from [the shared handling
paragraph](#the-shared-handling-paragraph) onward is the long-form reasoning these were condensed
out of, kept because it is what answers a reviewer's follow-up and because it is where the argument
for a scope is maintained when the scope changes.

All three end their opening paragraph by volunteering that the hosted client is optional. That
sentence is there deliberately: a reviewer assessing restricted scopes is deciding whether this
application can reach user data through a third-party server, and the honest answer is easier to
accept when it arrives unprompted and with the escape hatch attached. It is the same argument [the
security assessment](#the-security-assessment-and-the-question-that-decides-it) section makes at
length, compressed to one clause. Do not drop it to buy characters for something else.

### Your sensitive scopes — 995 characters

> Lanes Link is an open-source MCP endpoint the user runs on their own machine, so the AI agent they chose can act on their Google data when they ask. Requests go from that machine straight to Google and back: no Lanes server in that path, no copy kept, never sold, advertised against, or used to train AI. Our shared OAuth client is optional; --own-client uses their own.
>
> Calendar (calendar.readonly, calendar.events): show their schedule, answer "when am I free", and create or reschedule events they ask for. The read-only forms cannot create an event.
>
> Docs and Sheets (documents, spreadsheets): read a doc or sheet to answer a question about it and make the edits they ask for. The .readonly forms cannot write.
>
> Tasks (tasks): list their tasks, add one, mark one done. Google publishes no narrower write scope.
>
> Contacts (contacts.readonly, contacts.other.readonly): turn a name into an email address when they say "email Bob about the invoice". Read-only, and only a search they asked for.

### Your restricted scopes → Drive scopes — 994 characters

**What features will you use?** *Drive productivity*, and nothing else. Nothing copies Drive
content anywhere for retention, so not *Drive backup*; nothing mirrors Drive to a local folder, so
not *Drive sync client*.

> Lanes Link is an open-source MCP endpoint the user runs on their own machine so their agent can find and read the files they name. File content goes from that machine straight to Google and back: no Lanes server in that path, no copy kept, never sold, advertised against, or used to train AI models. Our shared OAuth client is optional; --own-client uses the user's own and removes us from the credential exchange.
>
> drive.readonly covers files.list (search), files.get, files.export (Google-native files have no downloadable bytes), permissions.list (sharing) and about.get (quota).
>
> Nothing narrower works. drive.file is requested alongside it and bounds every write, but alone reaches only files this app created or the user picked in the Google Picker - and there is no picker: this is a command-line endpoint with no UI. A file is named by title in conversation, so it must be findable by search - files.list. drive.metadata.readonly returns no content. Unrestricted drive is not requested.

### Your restricted scopes → Gmail scopes — 992 characters

**What features will you use?** *Email client* and *Email productivity*. Reading, searching,
drafting and sending is client behaviour; archiving, labels and filters is productivity. The scope
set spans both, and picking one leaves the other half unexplained — client alone makes
`settings.basic` look stray, productivity alone weakens `compose`. Nothing about backup, migration,
monitoring, compliance, anti-spam or CRM applies.

> Lanes Link is an open-source MCP endpoint the user runs on their own machine so their agent can read, write and organise their mail. Mail goes from that machine straight to Google and back: no Lanes server in that path, no copy kept, never sold, advertised against, or used to train AI models. Our shared OAuth client is optional; --own-client uses the user's own and removes us from the credential exchange.
>
> gmail.readonly: messages/threads.list and .get, labels, drafts, attachments.get, filters.list. gmail.metadata returns no body, so "summarise this thread" fails.
> gmail.compose: drafting and sending. gmail.send cannot create or revise a draft, and drafting keeps the user in the loop.
> gmail.modify: read/unread, archive, spam, folders, labels. Gmail has no narrower verb: each is messages.modify, since a folder is a label.
> gmail.settings.basic: filters.create/delete, to block a sender. No other scope accepts it.
>
> mail.google.com is not requested; no permanent deletion, only trash.

Each was cut to fit, and what got cut is the same thing every time: the handling paragraph below
shrank to one clause, and the per-operation detail shrank to what a reviewer reads rather than what
an implementer needs. What was kept in all three is the narrower-scope argument, one clause per
group, because the prompt asks for it by name and it is the half a submission is rejected on.

The sensitive box is deliberately the plainest of the three. It carries seven scopes across four
products, and a reviewer meeting it has no reason to know an API method name — so it names the
product, says what the user gets, and gives the narrower-scope answer in a clause. It also does not
list the scopes that were *not* requested. That argument is real and it is made at length below, but
in 1000 characters shared by seven scopes the space goes to what is being asked for. The restricted
boxes still make it, because `drive.file` versus `drive.readonly` and the absence of
`mail.google.com` are the questions those reviewers actually arrive with.

### Additional info — 974 characters

A fourth box, at the end of the submission after the scope justifications and the video link, and
the only one on the form that is optional. It is where [the broker](#the-security-assessment-and-the-question-that-decides-it)
gets stated, because there is nowhere in a scope justification that it fits and being asked is worse
than volunteering. Google also asks outright here for "the project IDs of any other projects that
use OAuth", which for this application is the sign-in project ADR-031 keeps separate — so answer it.

`PROJECT_ID` is a placeholder: the sign-in project's id goes there when this is pasted, and does not
get written back into this file. The measured length leaves room for it.

> Two things, stated before you ask.
>
> 1. Where user data goes. Lanes Link is an open-source CLI the user installs and runs themselves (github.com/lanes-sh/link). Their Google data moves directly between that machine and Google: we operate no server in that path and keep no copy. What does reach a Lanes server is the OAuth authorization code and the refresh token, in transit through our token broker and not retained, plus a salted one-way hash of the account id, used to rate-limit the shared client. An installed app cannot hold a client secret, which is the only reason the broker exists. --own-client registers the user's own client and removes us from that path too.
>
> 2. Other OAuth projects. Sign-in and data access are deliberately separate. The sign-in client lives in project PROJECT_ID and requests only openid, email and profile: no sensitive or restricted scopes.
>
> To try it: bun install -g @lanes-sh/link, then lanes link connect gmail. No Lanes account needed.

## The shared handling paragraph

This is the full statement of what becomes of the data, and it no longer fits in the console: the
grouped boxes are 1000 characters and the narrower-scope argument has to win that space. Each of
the three texts above carries a one-clause form of it instead, and this is what that clause
compresses. It is kept whole because it is what to send if a reviewer asks, and because the privacy
policy has to stay consistent with it.

> Lanes Link is software the user runs on their own machine. The request goes from that machine
> directly to Google and the response returns to it — Lanes operates no server in that path and
> holds no copy. The response is handed to the AI agent the user chose and configured, at the
> moment they asked for it, under per-capability permissions that deny everything by default.
> Google user data is never used for advertising, never sold or transferred to a third party,
> never read by a person at Lanes, and never used to develop, improve or train generalised or
> non-personalised artificial intelligence or machine learning models. The only things that reach
> a Lanes server are the OAuth authorization code and the refresh token, in transit through the
> token broker and not retained, and a salted irreversible hash of the account identifier, used to
> enforce the per-account limit on the shared client. The full statement is at
> <https://lanes.sh/privacy>, section 7.

## Gmail

Everything from here on is long-form: one section per scope, at the length the argument actually
takes. None of it is pasted as-is — [What goes in the console
today](#what-goes-in-the-console-today) is what goes in the boxes. This is where the reasoning
lives, where a reviewer's follow-up is answered from, and what has to be edited when an operation
is added to `SELECTION`.

### `gmail.readonly`

**Justification.** Reading and searching mail is the primary feature: the user asks their agent
what a message said, what a thread concluded, or which messages match a query, and the agent
answers from Gmail. This scope covers `messages.list` and `messages.get` (search over Gmail's own
`q` syntax, then retrieval by id), `threads.list` and `threads.get`, `labels.list` and
`labels.get`, `drafts.list` and `drafts.get`, `messages.attachments.get`, `getProfile` for the
address the connection belongs to, and `settings.filters.list`.

Nothing narrower works. `gmail.metadata` returns headers and label ids and no body or attachment,
so "what does this say" and "summarise this thread" — the two things most often asked — cannot be
answered at all. `gmail.addons.current.message.readonly` is scoped to the single message an add-on
is currently open on; Lanes Link is not a Gmail add-on, runs in a terminal, and has no such
context.

**Intended data usage.** Message headers, bodies and attachments, thread structure, label names,
existing filter definitions, and the account's own address are returned over TLS to the user's
machine. *(Then the shared handling paragraph.)*

### `gmail.compose`

**Justification.** Drafting and sending. `gmail.send_message` assembles the RFC 2822 message and
posts it — as a draft when the user asks for one, as a send when they ask for that;
`drafts.send` sends a draft that already exists and `drafts.delete` discards one.

`gmail.send` is narrower and insufficient: it can send but cannot create, revise or discard a
draft, and drafting is what keeps a person in the loop. The intended flow is that the agent writes,
the user reads it in Gmail on their phone or in the browser, and the send is a second and separate
act. Removing the draft step would make every agent-composed message an immediate send, which is
worse for the user and not what is being built. `gmail.insert` and `https://mail.google.com/` are
broader and are not requested.

**Intended data usage.** The content of a message the user asked to be written — recipients,
subject, body, and any attachment they named — is transmitted to Gmail to create a draft or send
it. Attachments are resolved from a path or URL by the endpoint on the user's own machine and
streamed to Google; the endpoint records the filename, size, media type and SHA-256 in the local
audit log and does not record the content. *(Then the shared handling paragraph.)*

### `gmail.modify`

**Justification.** Organising mail: marking read and unread, archiving, reporting spam, moving
between folders, and maintaining the label vocabulary itself. This covers `messages.modify`,
`messages.batchModify`, `threads.modify`, `messages.trash` and `untrash`, `threads.trash` and
`untrash`, and `labels.create`, `labels.update` and `labels.delete`.

There is no narrower scope, because Gmail has no separate verb for any of it. Marking read is
removing the `UNREAD` label; archiving is removing `INBOX`; reporting spam is adding `SPAM`; and
moving a message to a folder is adding that folder's label id, because a Gmail folder *is* a label.
Every one of those is `messages.modify`. `gmail.labels` governs the label vocabulary — creating and
deleting the labels themselves — and not their application to a message, so it covers the last of
those operations and none of the others. Permanent deletion is not part of this and is not offered:
`messages.delete` requires `https://mail.google.com/`, which is not requested, and trash is the
recoverable form of the same intent.

**Intended data usage.** Message ids, thread ids and label ids are transmitted to Gmail to apply
the change the user asked for, and label names are transmitted when the user asks for a new label.
Message content is read under `gmail.readonly` rather than here. *(Then the shared handling
paragraph.)*

### `gmail.settings.basic`

**Justification.** Blocking a sender. `settings.filters.create` and `settings.filters.delete`
accept this scope and no other, and a filter is the only thing in Gmail that acts on mail which has
not arrived yet. It is a genuinely different feature from reporting spam: that trains the
classifier on a message already received and is the label edit under `gmail.modify` above, and it
does nothing about the next message from the same sender.

Reading the filters that already exist is `settings.filters.list`, which accepts `gmail.readonly`
and does not need this scope. Nothing else in Lanes Link uses it: no signature, vacation responder,
forwarding address, send-as alias, or IMAP/POP setting is read or written, and no capability exists
that could.

**Intended data usage.** The criteria of a filter the user asked to create — in the common case a
sender address — and the id of a filter they asked to delete are transmitted to Gmail. *(Then the
shared handling paragraph.)*

## Drive, Docs and Sheets

### `drive.readonly`

**Justification.** Finding and reading the files the user points the agent at: `files.list` for
search, `files.get` for metadata, `files.export` to render a Google-native file to a portable
format because its bytes are not directly downloadable, `permissions.list` for who a file is shared
with, and `about.get` for storage quota.

`drive.file` is requested alongside this and is not sufficient on its own. It reaches only files
this application created and files the user selected through the Google Picker — and there is no
picker here. Lanes Link is a command-line MCP endpoint with no UI to host one: the user names a
file by its title in conversation with their agent, which means it has to be findable by search,
which is `files.list` and needs this scope. `drive.metadata.readonly` returns names and properties
but no content, so "read this document to me" and "what does this spreadsheet say" both fail.
Unrestricted `drive` is not requested.

**Intended data usage.** File names and metadata, sharing information, storage quota, and the
contents of files the user asks about are returned to the user's machine. *(Then the shared
handling paragraph.)*

### `drive.file`

No fields are required — it is neither sensitive nor restricted. It is listed here because it is
requested, and because it is load-bearing in the justification above: every Drive **write** Lanes
Link performs is bounded by it. `files.create`, `files.update`, `files.copy` and
`permissions.create` reach only files this application itself made, which is why there is no
rename-anything or share-anything capability.

### `documents`

**Justification.** Reading and editing Google Docs. `documents.get` returns the document as a
structure, which is how the index to edit at is found, and `documents.batchUpdate` is the entire
Docs write surface — there is no per-operation scope and no `values`-style shortcut.
`documents.readonly` covers the first of the two and none of the editing, and editing is the
feature.

Drive cannot substitute for it. Drive treats a Google-native file as an opaque blob, and the only
route back in would be `files.update` with media — a whole-file replace through import conversion,
which discards headings, formatting, comments and suggestions. Paragraph-level editing exists
solely in the Docs API.

**Intended data usage.** Document content is read to answer the user's question and to locate the
position of an edit, and the text the user asked to insert or change is transmitted to Google.
*(Then the shared handling paragraph.)*

### `spreadsheets`

**Justification.** Reading and writing cell values and sheet structure: `spreadsheets.get` for
tabs, named ranges and dimensions; `values.get` and `values.batchGet` to read a range;
`values.update`, `values.batchUpdate`, `values.append`, `values.clear` and `values.batchClear` to
write one; `sheets.copyTo` to copy a tab into a different spreadsheet; and `spreadsheets.batchUpdate`
for structural edits — tabs, frozen rows, formatting, charts and conditional formats.

`spreadsheets.readonly` covers the reads and none of the writes, and writing a range is the point:
"read this range, work out the totals, write them back" is the ordinary request. As with Docs,
Drive cannot substitute — no Drive operation edits a cell, and a whole-file replace through import
conversion would discard formulas, formatting and comments.

**Intended data usage.** Cell values and spreadsheet structure are read, and the values and
structural changes the user asked for are transmitted to Google. *(Then the shared handling
paragraph.)*

## Calendar, Tasks and Contacts

### `calendar.readonly`

**Justification.** Two operations accept nothing narrower, and both are foundational rather than
incidental. `calendarList.list` is how the agent learns which calendars exist and what time zone
the primary one is in — without it every event created lands in the wrong zone, because there is
nowhere else to read that from. `freebusy.query` answers "when am I free", across calendars whose
*contents* the token may not be permitted to read; it returns busy intervals rather than events,
and it is the primitive that scheduling anything depends on.

`calendar.events` grants access to events and neither of these two. Full `calendar` is not
requested: nothing in Lanes Link creates, deletes or re-shares a calendar, and every operation that
would need it is deliberately absent.

**Intended data usage.** The list of the user's calendars, their time zones, and busy/free
intervals are returned to the user's machine. `freebusy` returns intervals, not event contents.
*(Then the shared handling paragraph.)*

### `calendar.events`

**Justification.** Reading and changing events: `events.list`, `events.get` and `events.instances`
to read — the last because `list` does not expand a recurring event unless asked — and
`events.insert`, `events.patch`, `events.delete` and `events.move` to change one.

`calendar.events.readonly` covers the reads only, and creating the event the user asked for is the
feature. `calendar.events.owned` is narrower still but excludes events on calendars shared with the
user, which for anyone working with other people is a large part of a real calendar. Full `calendar`
is deliberately not requested. Note also that there is no PUT here: `events.update` replaces the
resource, so an agent that read an event, changed the title and sent it back would silently drop
attendees, reminders, recurrence and conferencing — only `patch` is offered.

**Intended data usage.** Event titles, times, attendees, locations and descriptions are read to
answer the user's question, and the details of an event the user asked to create or change are
transmitted to Google. *(Then the shared handling paragraph.)*

### `tasks`

**Justification.** Reading and writing task lists: `tasklists.list`, `tasks.list` and `tasks.get`
to read; `tasklists.insert` and `tasklists.patch`, `tasks.insert`, `tasks.patch`, `tasks.delete`
and `tasks.move` to write.

The Tasks API publishes exactly two scopes, `tasks` and `tasks.readonly`. The read-only one covers
the three reads and none of the writes, and adding a task is the feature — so `tasks` is the
narrowest scope that works, and there is no per-operation alternative to prefer. Two operations it
would permit are deliberately not offered: `tasklists.delete` destroys a list and every task in it
and Tasks has no trash, and `tasks.clear` hides every completed task in a list in one call while
naming none of them, which would leave an audit entry that could not say what it did.

**Intended data usage.** Task titles, notes, due dates and completion state are read, and the tasks
and lists the user asked to create or change are transmitted to Google. *(Then the shared handling
paragraph.)*

### `contacts.readonly`

**Justification.** Turning a name into an address. `people.searchContacts` is what makes "email
Bob about the invoice" resolvable at all, and `people.getBatchGet` retrieves the contacts search
returned.

The People API offers two read paths into a user's own contacts, `contacts.readonly` and full
`contacts`, and the second is a write grant that is not requested — so this is the narrowest scope
that works. Enumeration is not offered: `people.connections.list`, which would list every contact,
is deliberately absent, so the only way a contact is read is that the user asked for one by name.

**Intended data usage.** The names, email addresses and phone numbers of contacts matching a search
the user asked for are returned to the user's machine. Contacts are never enumerated, bulk-exported
or copied anywhere. *(Then the shared handling paragraph.)*

### `contacts.other.readonly`

**Justification.** "Other contacts" is the separate store where Gmail files an address that has
been written to but never saved as a contact, and for the request this exists to serve — "reply to
the person who sent the quote" — it is more often than not where that address actually is.
`people.otherContacts.search` accepts this scope and nothing else; `contacts.readonly` does not
reach the store at all. It is read-only and has no narrower form.

**Intended data usage.** The names and email addresses of auto-saved addresses matching a search
the user asked for are returned to the user's machine. *(Then the shared handling paragraph.)*

## The demo video

**One** unlisted YouTube video covering every scope. Not one per scope — a single recording is
required to cover all of them, which is the whole reason it is worth recording last, after the
scope set has stopped moving. The URL field is no longer on the Data access page and is not asked
for per scope; it is collected once at the final submission step, after the boxes above are
filled.

There is no way to avoid it here. A video is required for *sensitive* scopes as well as restricted
ones, so dropping all five restricted scopes would still leave seven that need it; the only routes
that skip it are the ones that skip verification altogether — Internal, Testing, personal use, and
domain-wide install — and Testing is the status [ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md)
exists to escape.

Four things are asked for, and the bar is lower than "demo video" suggests — it is a screen
recording of the tool being used, not a produced asset:

- the OAuth grant process **in English**;
- the consent screen displaying the application name correctly;
- the browser address bar, on that consent screen, showing the OAuth client id;
- the functionality each requested scope enables, actually exercised.

Shot list — connect, consent, then exercise, one provider at a time:

1. `https://lanes.sh/link` — what the application is and who runs it.
2. `lanes link connect gmail`. The consent screen, with the application name and all four Gmail
   scopes legible and the address bar showing the client id. Approve. Then: search and read a
   message, archive one and mark another unread, draft a message and send it, create a filter that
   blocks a sender.
3. `lanes link connect drive`. List and read a file, then create one — `drive.readonly` and
   `drive.file`.
4. `lanes link connect sheets` and `lanes link connect docs`. Read a range and write it back; read
   a document and edit a paragraph.
5. `lanes link connect calendar`. Show free/busy and the calendar list, then create an event.
6. `lanes link connect tasks`. List, then create and complete one.
7. `lanes link connect contacts`. Search a name to an address, including one that resolves out of
   Other contacts.

**Every account, address, file, event and contact on screen must belong to a throwaway test
account.** The video becomes a public URL attached to the project. The rule against real
identifiers in this repository exists because it was broken once and cost eighty-nine commits to
undo; a video is worse, because there is no history to rewrite.

## Before submitting

Five checks, in the order they bite. The first is the only one that cannot be undone.

**Submit the project that holds the Google-data client, not the one that signs people in.**
[ADR-031](adr/031-sign-in-and-data-access-are-separate-projects.md) is the argument; the operational
half is that a submission enters *every* client in that project into the review, and that the
unverified-app cap is spent for the lifetime of a project and cannot be reset. Submitting the wrong
one is not a mistake that gets corrected later.

**Confirm the sign-in project's Data access page still lists nothing but `openid`, `email` and
`profile`.** A sensitive scope registered there is what puts an unverified-app screen in front of
someone who only clicked "sign in", and no test in any repository can see it. This is the check that
keeps the two levels apart, and it is worth repeating whenever a scope is added anywhere.

**Point the privacy policy field at <https://lanes.sh/privacy>, with no query string.** That page
exists for this field, and says so in its own source: review tooling will not follow a query
parameter into a client-side tab. A `?tab=` form resolves to the same document for a human and is a
gratuitous chance for a reviewer to land somewhere unintended.

**Fill all three boxes and both feature dropdowns** from [What goes in the console
today](#what-goes-in-the-console-today). The console refuses the submission until every sensitive
and restricted scope is covered by the box it sits under; `drive.file` needs nothing, and the video
URL is asked for later.

**Say what the broker is before anyone asks.** The next section is why.

## The security assessment, and the question that decides it

The five restricted scopes are what raise it. Google's stated trigger is narrow, and it is worth
reading precisely rather than assuming:

> Every app that requests access to Google users' restricted data **and has the ability to access
> data from or through a third-party server** must go through a security assessment.

Lanes Link's answer to the first half is yes and to the second half is *almost* no, and the gap is
the broker. Mail, files, documents, events, tasks and contacts move directly between the user's
machine and Google; no Lanes server is in that path and there is no copy — that is what
[`security.md`](security.md) states and what the architecture enforces. But
[ADR-028](adr/028-a-hosted-oauth-client-is-the-default.md) puts the authorization code and every
subsequent refresh through the Lanes API, because an installed application cannot hold a
confidential client secret. So the API handles a credential that *could* be used to reach
restricted data, even though it never does.

Whether that constitutes "the ability to access data through a third-party server" is a question of
fact about the broker, and the answer is the difference between a review measured in weeks and one
measured in months plus an annual third-party assessment. Put it in the submission notes
explicitly — what the broker holds, what it does not, that no user data passes through it, and that
`--own-client` removes it from the path entirely — rather than leaving the reviewer to infer it.
`security.md` already records the honest version as `credentials.exchange-is-local: NOT-GUARANTEED`,
and saying so first is better than being asked.

Do not wait on the answer. If an assessment is required it is the critical path, and everything
above can proceed alongside it.

## Keeping this true

`src/providers/google/specs/specs.test.ts` checks both directions against the block above: every
scope a manifest requests appears here, and every scope named here is requested by some manifest.
The second is the one that matters for a submission — a scope dropped from a manifest but left in
the console text is a standing request for access the application no longer uses.

What the test cannot check is whether the *prose* still describes what the capability does. When an
operation is added to `SELECTION` in
[`specs/vendor.ts`](../../src/providers/google/specs/vendor.ts), the justification for the scope it
lands under is part of the change, and so is re-recording the demo video if the operation is
user-visible.
