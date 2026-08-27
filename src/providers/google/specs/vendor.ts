/**
 * Vendor trimmed OpenAPI specs for Google's REST APIs.
 *
 * Google's MCP servers are gated behind a Workspace Developer Preview that a
 * personal account cannot enrol in, so the REST APIs are the path that works
 * for everyone. They publish Discovery documents rather than OpenAPI; APIs.guru
 * generates OpenAPI from those, which is what this reads.
 *
 * The output is **committed**, and that is the point. A spec decides which
 * paths get called with the operator's token, and `connect` now grants
 * everything a provider discovers — so a spec fetched at connect time from a
 * third party could introduce, say, a DELETE operation that lands on Google's
 * own host holding a real mailbox token. Vendoring makes the surface reviewable
 * and the build reproducible; this script exists so refreshing it is one
 * command rather than a hand edit.
 *
 *   bun run vendor:google
 *
 * The pipeline itself is `src/providers/shared/vendor-spec.ts`. What stays here
 * is what only Google knows: which operations are worth exposing, and which of
 * its system parameters have to go.
 */

import { vendorSpec } from '../../shared/vendor-spec.ts';

/**
 * The operations each provider exposes.
 *
 * Curated, and deliberately so: Gmail's spec has 79 operations and Drive's 48,
 * which is more than an agent can reason over and far more than either provider
 * claims to be. Everything here is reachable under the scopes the manifest
 * requests — nothing is listed that would fail on permission.
 */
const SELECTION: Record<
  string,
  { source: string; out: string; operations: string[]; opaque?: string[] }
> = {
  gmail: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/gmail/v1/openapi.json',
    out: 'gmail.v1.json',
    operations: [
      'gmail.users.getProfile',
      'gmail.users.labels.list',
      'gmail.users.labels.get',
      'gmail.users.messages.list',
      'gmail.users.messages.get',
      'gmail.users.messages.attachments.get',
      'gmail.users.threads.list',
      'gmail.users.threads.get',
      'gmail.users.drafts.list',
      'gmail.users.drafts.get',
      // Write, all of it `gmail.compose`, all of it in the write bundle.
      // `delete` addresses a draft that already exists, which is the half that
      // was missing: without it the only way to discard a draft was the Gmail
      // UI.
      'gmail.users.drafts.send',
      'gmail.users.drafts.delete',
      // Organising, all of it `gmail.modify`. Gmail has no separate verb for
      // read-state or spam: marking read is removing `UNREAD`, marking spam is
      // adding `SPAM`, archiving is removing `INBOX`. It is all label edits, so
      // `modify` is the whole feature and there is no narrower scope that does
      // it — `gmail.labels` governs the label vocabulary, not its application.
      'gmail.users.messages.modify',
      'gmail.users.messages.batchModify',
      'gmail.users.messages.trash',
      'gmail.users.messages.untrash',
      'gmail.users.threads.modify',
      'gmail.users.threads.trash',
      'gmail.users.threads.untrash',
      'gmail.users.labels.create',
      'gmail.users.labels.update',
      'gmail.users.labels.delete',
      // Blocking a sender, which is the one mail verb nothing above reaches.
      // Adding `SPAM` to a message is Report-spam and trains the classifier;
      // Block-sender is a filter, and a filter is the only thing here that acts
      // on mail that has not arrived yet. `create` and `delete` accept
      // `gmail.settings.basic` and nothing else, which is why the manifest asks
      // for it and why it is marked broad.
      //
      // `list` is here because a create tool with no way to see what already
      // exists is half a feature — and it is free, accepting `gmail.readonly`,
      // which the manifest already held. `get` is not: `list` returns every
      // filter in full, so it is the `labels.patch` objection again.
      'gmail.users.settings.filters.list',
      'gmail.users.settings.filters.create',
      'gmail.users.settings.filters.delete',
      //
      // Not listed, deliberately: `messages.delete` and `threads.delete` are
      // permanent and would force `mail.google.com`, the one scope we refuse;
      // `labels.patch` duplicates `update`, and a redundant tool costs context
      // on every call; `messages.insert`/`import` take a full `Message` body,
      // which is the `cutCycles` hazard below.
      //
      // `drafts.create` was here and is gone, which is the `labels.patch`
      // objection with a bill attached. `send_message` already creates drafts —
      // `draft_only: true` posts the assembled message to /drafts — so the two
      // differed only in whether the endpoint composed the MIME for you, with
      // nothing in the tool list saying so. The generated one took a base64url
      // `raw` the caller had to assemble, which is the failure ADR-017 exists
      // for: a 239 KB PDF is about 320,000 characters a model cannot write in
      // one message. Two tools for one job, one of which cannot attach a file.
      // The test in `specs.test.ts` that was supposed to catch this only knew
      // about `messages.send`; it knows about drafts now.
      //
      // `drafts.update` followed it out, one change later and for exactly the
      // same reason — it was kept at first only because nothing else could
      // revise a draft, and that stopped being true when `send_message` grew
      // `draft_id`. The `Draft` body is the same unusable shape either way:
      // workable for a line of text, impossible for the attachment that is the
      // whole reason someone is correcting a draft rather than retyping it.
    ],
  },
  drive: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/drive/v3/openapi.json',
    out: 'drive.v3.json',
    operations: [
      'drive.about.get',
      'drive.files.list',
      'drive.files.get',
      'drive.files.export',
      'drive.permissions.list',
      // Write, and every one of them limited to files this app created by the
      // `drive.file` scope. That bound is why there is no rename-anything tool
      // here: `drive.file`'s other half is files the user picks, which arrives
      // through the Google Picker, and there is no picker on an MCP endpoint.
      'drive.files.create',
      'drive.files.update',
      'drive.files.copy',
      'drive.permissions.create',
      //
      // Not listed, deliberately: `files.delete` is permanent, and Drive has a
      // trash — `files.update` with `trashed: true` is the recoverable form of
      // the same intent, which is the `messages.delete` reasoning again.
      // `permissions.update` and `permissions.delete` would let an agent revoke
      // access it did not grant, including somebody else's.
    ],
  },
  //
  // Sheets and Docs exist because Drive cannot do this. Drive treats a Google
  // file as an opaque blob: there is no Drive operation that edits a cell, and
  // the only route back in would be `files.update` with media — a whole-file
  // replace via import conversion, which discards formulas, formatting, tabs,
  // and comments. Cell-level editing lives solely in the Sheets API, and
  // paragraph-level editing solely in the Docs API.
  sheets: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/sheets/v4/openapi.json',
    out: 'sheets.v4.json',
    opaque: ['Request', 'Response'],
    operations: [
      'sheets.spreadsheets.get',
      'sheets.spreadsheets.values.get',
      'sheets.spreadsheets.values.batchGet',
      // Write. `values.*` is the whole point of the provider — reading a range
      // and writing it back is what "work on the file directly" means.
      'sheets.spreadsheets.values.update',
      'sheets.spreadsheets.values.batchUpdate',
      'sheets.spreadsheets.values.append',
      'sheets.spreadsheets.values.clear',
      // The N-ary form of `values.clear`, and here for consistency rather than
      // reach: `values.batchGet` and `values.batchUpdate` are both already the
      // batch forms of vendored unary operations, so refusing this one alone
      // was an inconsistency with no argument behind it. It also collapses
      // clearing five tabs from five audit events into one that names all five
      // ranges. Measured at 0.6 KB.
      'sheets.spreadsheets.values.batchClear',
      // Copying a tab into a *different* spreadsheet, which nothing else here
      // can do: `batchUpdate`'s `DuplicateSheetRequest` cannot cross a file
      // boundary, and `drive.files.copy` copies the whole file. Not the
      // `labels.patch` objection — that refused a redundant tool, and this is
      // reachable no other way. Measured at 0.7 KB.
      'sheets.spreadsheets.sheets.copyTo',
      // Structural edits — tabs, formatting, frozen rows, charts. Only reachable
      // at all because `Request` is made opaque below; see `makeOpaque`.
      'sheets.spreadsheets.batchUpdate',
    ],
  },
  docs: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/docs/v1/openapi.json',
    out: 'docs.v1.json',
    opaque: ['Request', 'Response'],
    operations: [
      'docs.documents.get',
      // The only way to edit a document at all. Docs has no `values`-style
      // shortcut, so this operation is the entire write surface.
      'docs.documents.batchUpdate',
    ],
  },
  calendar: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/calendar/v3/openapi.json',
    out: 'calendar.v3.json',
    operations: [
      'calendar.calendarList.list',
      'calendar.events.list',
      'calendar.events.get',
      'calendar.events.instances',
      // Reading, but a POST: `freeBusy` takes a body because it asks about
      // several calendars at once. It is the "when am I free" primitive, and
      // the reason `calendar.readonly` is requested beside `calendar.events` —
      // this operation and `calendarList.list` accept nothing narrower.
      'calendar.freebusy.query',
      // Write, all of it `calendar.events`. Nothing here needs full `calendar`.
      'calendar.events.insert',
      'calendar.events.patch',
      'calendar.events.delete',
      'calendar.events.move',
      //
      // Not listed, deliberately. `events.update` is the PUT beside `patch`,
      // and this is the inverse of the `labels.patch` decision above: there the
      // two were the same call and the redundant one went, here they differ and
      // the difference destroys data. PUT replaces the resource, so an agent
      // that reads an event, edits `summary`, and sends it back drops
      // everything it did not echo — attendees, reminders, recurrence,
      // conferencing. One of them is needed and only one of them is safe.
      // `events.quickAdd` parses "lunch with Bob Tuesday" into an event, which
      // is a service for a caller that cannot do that itself; a model can, and
      // `insert` takes the end time and time zone that quickAdd has to guess.
      // `events.import`, `calendars.*`, `calendarList.insert`/`delete` and
      // `acl.*` create, delete, or re-share whole calendars, and every one of
      // them requires the full `calendar` scope — the scope this provider
      // exists to avoid. The `watch` operations push to a webhook this endpoint
      // does not have. `colors.get` and `settings.list` answer nothing anyone
      // asked: the primary calendar's time zone is already in `calendarList`.
    ],
  },
  tasks: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/tasks/v1/openapi.json',
    out: 'tasks.v1.json',
    operations: [
      'tasks.tasklists.list',
      'tasks.tasks.list',
      'tasks.tasks.get',
      // Write. Tasks publishes exactly two scopes — `tasks` and
      // `tasks.readonly` — so every line below is the same grant as every
      // other, and there is no narrower one to prefer.
      'tasks.tasklists.insert',
      'tasks.tasklists.patch',
      'tasks.tasks.insert',
      'tasks.tasks.patch',
      'tasks.tasks.delete',
      'tasks.tasks.move',
      //
      // Not listed, deliberately: `tasklists.delete` destroys a list and every
      // task in it, and Tasks has no trash — the `messages.delete` refusal
      // applied to the container rather than the item. `tasks.clear` hides
      // every completed task in a list in one call, naming none of them, so the
      // audit entry could not say what it did. `tasklists.update` and
      // `tasks.update` are the PUTs beside the PATCHes; see `events.update`.
      // `tasklists.get` is `tasklists.list` with an argument.
    ],
  },
  //
  // `contacts` rather than `people`: the API is People, but the thing an
  // operator connects is their contacts, and `icloud_contacts` is already the
  // neighbour. It is the one key here whose name differs from the API it
  // vendors, which matters in `redact.ts` — see the note there.
  contacts: {
    source: 'https://api.apis.guru/v2/specs/googleapis.com/people/v1/openapi.json',
    out: 'people.v1.json',
    operations: [
      'people.people.searchContacts',
      'people.people.getBatchGet',
      // A second store, and a second scope. "Other contacts" is where Gmail
      // files an address written to but never saved, which for "email Bob" is
      // more often than not where Bob actually is.
      'people.otherContacts.search',
      //
      // Not listed, and this one is not a judgement call: `people.people.get`
      // and `people.people.connections.list` cannot work through this
      // connector. Google's discovery document writes their paths as
      // `v1/{+resourceName}` — RFC 6570 reserved expansion, which permits the
      // slash that every value has (`people/me`, `people/c8891…`). The OpenAPI
      // conversion drops the `+`, and `buildPath` percent-encodes a path value
      // as a single segment, which is correct for a plain `{var}` and fatal
      // here. What goes out is `/v1/people%2Fme`, and Google's frontend answers
      // 404 with an HTML page; the same URL with a literal slash reaches the
      // API and answers 403 for the missing credential. Measured against the
      // live service, not reasoned. Both would list fine, pass policy, and fail
      // every call — so the enumeration of every contact is deliberately absent
      // and `searchContacts` is how a name becomes an address.
      //
      // Also not listed: everything under the `contacts` write scope, and
      // `directory.readonly`, which is a Workspace directory and a 403 on a
      // personal account. `contactGroups.*` only helps filter an enumeration
      // this provider does not have.
    ],
  },
  //
  // Not listed for either, deliberately: `spreadsheets.create` and
  // `documents.create`. `drive.files.create` already makes an empty Google-native
  // file by `mimeType` under scopes we hold anyway, and their request bodies are
  // whole `Spreadsheet`/`Document` objects — the same hazard class as the
  // `messages.insert` rejected above.
  //
  // This used to say "122 and 101 extra schemas", which is the wrong number to
  // argue with and nearly got the decision reversed: a schema count reads
  // arguable, and the budget in `cli/tools.test.ts` is 64 KB of *generated*
  // input schema. Those differ by 40× here, because `mcp-from-openapi` inlines
  // `$ref`s and a shared schema is duplicated at every use site. Measured with
  // the real generator, `spreadsheets.create` is **1,133 KB** — 17.7× the
  // budget. `opaque: ['Request','Response']` does nothing for it: the body fans
  // out `Spreadsheet → Sheet → GridData → CellData → CellFormat/ChartSpec` and
  // `Spreadsheet → SpreadsheetProperties → CellFormat/SpreadsheetTheme`, and
  // neither path passes through `Request`.
  //
  // Adding `Sheet` to `opaque` gets it to 80.7 KB, still over. The only
  // configuration that fits also makes `SpreadsheetProperties` opaque — at
  // which point the tool cannot describe `title`, and it is a tool that tells
  // an agent nothing for a job `drive.files.create` does with typed `name`,
  // `mimeType`, and `parents`, uniformly for Sheets, Docs, and folders.
  // `documents.create` is the same shape at 98.1 KB, and Google ignores every
  // field but `title` on it anyway.
};

/**
 * Google's system parameters, dropped from every operation.
 *
 * Three reasons, in descending order of how badly they bite.
 *
 * `$.xgafv` is not a legal tool-property name: the Anthropic API requires
 * `^[a-zA-Z0-9_.-]{1,64}$`, and `$` fails it — so a single tool carrying it
 * rejects the *entire* tools list with a 400, and every provider on the
 * endpoint stops working, not just Gmail.
 *
 * `access_token`, `key`, and `oauth_token` let a caller supply their own
 * credentials as query parameters. Authentication belongs to the connector,
 * which sets a header; offering an agent a second way to authenticate is
 * offering it a way to authenticate as something else.
 *
 * The rest is noise that costs schema for nothing.
 *
 * `fields` and `alt` are deliberately kept: `drive.about.get` *requires*
 * `fields`, and `alt=media` is how file content is downloaded.
 */
const SYSTEM_PARAMETERS = new Set([
  '$.xgafv',
  'access_token',
  'callback',
  'key',
  'oauth_token',
  'prettyPrint',
  'quotaUser',
  'upload_protocol',
  'uploadType',
]);

/**
 * The note recorded in each spec's `info`, and the one `makeOpaque` leaves
 * behind. Both are baked into the committed JSON, so they are passed verbatim
 * rather than reworded.
 */
const VENDORED_NOTE =
  'Trimmed by src/providers/google/specs/vendor.ts. Committed deliberately: a spec decides which paths are called with the operator token, so it must be reviewable rather than fetched at connect time.';

const OPAQUE_NOTE =
  'Structure omitted: it expands to megabytes when inlined. ' +
  'Pass the object as documented at https://developers.google.com/workspace.';

for (const [id, selection] of Object.entries(SELECTION)) {
  await vendorSpec(id, {
    source: selection.source,
    // `import.meta.dir` *is* the specs directory — this script lives beside what
    // it writes. It used to be `scripts/vendor-google-specs.ts` and reached
    // across the tree; commit 3cd03ce moved the script and the specs together
    // but not the path arithmetic, so for a while this resolved to
    // `src/providers/google/providers/builtin/specs`, created it, reported
    // success, and left the committed spec untouched — making the documented
    // "re-run the script" step a silent no-op.
    outputDirectory: import.meta.dir,
    out: selection.out,
    operations: selection.operations,
    ...(selection.opaque ? { opaque: selection.opaque } : {}),
    opaqueNote: OPAQUE_NOTE,
    vendoredNote: VENDORED_NOTE,
    systemParameters: SYSTEM_PARAMETERS,
  });
}
