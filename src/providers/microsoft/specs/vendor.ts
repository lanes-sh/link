/**
 * Vendor trimmed OpenAPI specs for Microsoft Graph.
 *
 * One API behind five providers. Graph is a single enormous surface — 7,419
 * paths and 2,599 schemas in the published document — and mail, calendars,
 * contacts, files, and to-do are all reached through it under one OAuth client.
 * That is the opposite of Google, where each product has its own spec, and it is
 * why the selection below is keyed by *provider* rather than by API: what
 * separates `outlook_mail` from `outlook_calendar` is the operations each is
 * allowed to name, nothing else.
 *
 *   bun run vendor:microsoft
 *
 * The pipeline is `src/providers/shared/vendor-spec.ts`. What stays here is what
 * only Graph knows: which operations are worth exposing, and which of its OData
 * parameters have to go.
 */

import { vendorSpec } from '../../shared/vendor-spec.ts';

/** APIs.guru's generated OpenAPI for Graph v1.0 — the same source Google's uses. */
const SOURCE = 'https://api.apis.guru/v2/specs/microsoft.com/graph/1.0.1/openapi.json';

/**
 * Bodies narrowed to what the call actually writes.
 *
 * `PATCH /me/messages/{id}` takes a whole `microsoft.graph.message` — every
 * field of a mail item, including the ones the service computes — which inlines
 * to 346 KB against a 64 KB budget. What a caller changes on an existing message
 * is whether it has been read, how it is filed, and how urgent it is.
 *
 * Projected rather than hand-written, so a field Microsoft renames or makes
 * read-only fails `bun run vendor:microsoft` instead of becoming an argument
 * Graph silently ignores.
 */
const PROJECTED: Record<string, readonly string[]> = {
  'me.UpdateMessages': ['isRead', 'categories', 'flag', 'importance'],
  'me.CreateEvents': [
    'subject',
    'body',
    'start',
    'end',
    'location',
    'attendees',
    'isAllDay',
    'isOnlineMeeting',
    'reminderMinutesBeforeStart',
    'showAs',
    'recurrence',
  ],
  'me.UpdateEvents': [
    'subject',
    'body',
    'start',
    'end',
    'location',
    'attendees',
    'isAllDay',
    'isOnlineMeeting',
    'reminderMinutesBeforeStart',
    'showAs',
  ],
  'me.todo.CreateLists': ['displayName'],
  'me.todo.lists.CreateTasks': [
    'title',
    'body',
    'dueDateTime',
    'reminderDateTime',
    'importance',
    'status',
    'categories',
  ],
  'me.todo.lists.UpdateTasks': [
    'title',
    'body',
    'dueDateTime',
    'reminderDateTime',
    'importance',
    'status',
    'categories',
  ],
  'drives.items.CreateChildren': ['name', 'folder', 'file'],
};

/**
 * `sendMail`'s body, written out rather than projected.
 *
 * The only one that cannot be projected: Graph declares it as a shared
 * `requestBodies` component rather than a schema reference, so there is no
 * entity to narrow — and the wide form is the same 346 KB `message` again.
 *
 * Deliberately without `attachments`. Graph takes those as base64 inside the
 * message, which is precisely what ADR-017 exists to avoid; attaching a file
 * here would mean the model emitting the file. Sending an attachment from
 * Outlook needs the same treatment `gmail.send_message` has, and until it has
 * one, offering the field would be advertising a route that costs a context
 * window.
 */
const SEND_MAIL_BODY = {
  type: 'object',
  required: ['message'],
  properties: {
    message: {
      type: 'object',
      required: ['subject', 'body', 'toRecipients'],
      properties: {
        subject: { type: 'string' },
        body: {
          type: 'object',
          required: ['contentType', 'content'],
          properties: {
            contentType: { type: 'string', enum: ['text', 'html'] },
            content: { type: 'string' },
          },
        },
        toRecipients: { type: 'array', items: { $ref: '#/components/schemas/microsoft.graph.recipient' } },
        ccRecipients: { type: 'array', items: { $ref: '#/components/schemas/microsoft.graph.recipient' } },
        bccRecipients: { type: 'array', items: { $ref: '#/components/schemas/microsoft.graph.recipient' } },
      },
    },
    saveToSentItems: {
      type: 'boolean',
      description: 'Keep a copy in Sent Items. Defaults to true.',
    },
  },
} as const;

const SELECTION: Record<string, { out: string; operations: string[]; opaque?: string[] }> = {
  outlook_mail: {
    out: 'outlook-mail.v1.json',
    operations: [
      'me.ListMessages',
      'me.GetMessages',
      'me.UpdateMessages',
      'me.ListMailFolders',
      'me.sendMail',
      'me.messages.ListAttachments',
      'me.messages.GetAttachments',
    ],
  },
  outlook_calendar: {
    out: 'outlook-calendar.v1.json',
    operations: [
      'me.ListCalendars',
      'me.ListEvents',
      'me.GetEvents',
      'me.CreateEvents',
      'me.UpdateEvents',
      'me.DeleteEvents',
      'me.ListCalendarView',
    ],
  },
  outlook_contacts: {
    out: 'outlook-contacts.v1.json',
    operations: [
      // Read-only, matching Google's contacts provider rather than what Graph
      // would allow. An address book is what makes "email Bob" resolve; nothing
      // here needs to write one, and `Contacts.Read` is a materially smaller
      // grant than `Contacts.ReadWrite`.
      'me.ListContacts',
      'me.GetContacts',
      'me.ListContactFolders',
    ],
  },
  onedrive: {
    out: 'onedrive.v1.json',
    operations: [
      'me.GetDrive',
      'drives.GetRoot',
      'drives.GetItems',
      'drives.items.ListChildren',
      'drives.GetItemsContent',
      'drives.items.CreateChildren',
      'drives.drive.items.driveItem.search',
    ],
  },
  microsoft_todo: {
    out: 'microsoft-todo.v1.json',
    operations: [
      'me.todo.ListLists',
      'me.todo.CreateLists',
      'me.todo.lists.ListTasks',
      'me.todo.lists.GetTasks',
      'me.todo.lists.CreateTasks',
      'me.todo.lists.UpdateTasks',
      'me.todo.lists.DeleteTasks',
    ],
  },
};

/**
 * OData parameters that are noise rather than capability.
 *
 * Not the same judgement as Google's list, and worth saying why. `$select`,
 * `$filter`, `$top`, `$orderby` and `$search` are how a caller asks Graph for
 * less, and dropping them would leave an agent pulling whole mailboxes — so they
 * stay. What goes is the paging and shaping machinery an agent has no use for
 * here: `$expand` pulls related entities and multiplies the response, `$count`
 * and `$skip` belong to a pagination scheme `@odata.nextLink` already answers,
 * and `ConsistencyLevel` is a header for advanced queries none of these make.
 */
const SYSTEM_PARAMETERS = new Set(['$expand', '$count', '$skip', 'ConsistencyLevel']);

const VENDORED_NOTE =
  'Trimmed by src/providers/microsoft/specs/vendor.ts. Committed deliberately: a spec decides which paths are called with the operator token, so it must be reviewable rather than fetched at connect time.';

const OPAQUE_NOTE =
  'Structure omitted: it expands to megabytes when inlined. ' +
  'Pass the object as documented at https://learn.microsoft.com/graph/api/overview.';

for (const [id, selection] of Object.entries(SELECTION)) {
  await vendorSpec(id, {
    source: SOURCE,
    outputDirectory: import.meta.dir,
    out: selection.out,
    operations: selection.operations,
    ...(selection.opaque ? { opaque: selection.opaque } : {}),
    opaqueNote: OPAQUE_NOTE,
    vendoredNote: VENDORED_NOTE,
    systemParameters: SYSTEM_PARAMETERS,
    // Graph declares a path's parameters on the path item rather than on each
    // operation, so `{message-id}` is in the URL and in nothing the generator
    // reads. Without this it refuses the whole document with MISSING_PATH_PARAMETER
    // — the same shape Discord has, and the reason the flag is not Discord's.
    hoistPathParameters: true,
    projectRequestBody: PROJECTED,
    projectionNote:
      'The fields this call writes. A message carries far more, and the rest is computed by Graph ' +
      'rather than set here.',
    rewriteRequestBody: { 'me.sendMail': SEND_MAIL_BODY },
  });
}
