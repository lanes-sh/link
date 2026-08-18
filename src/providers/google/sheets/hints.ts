/**
 * Where the Sheets surface stops, and what continues it.
 *
 * Two gaps, both of which read as missing features rather than as boundaries.
 *
 * There is no `spreadsheets.create` here and there will not be: its request
 * body is a whole `Spreadsheet`, which generates a 1,133 KB input schema
 * against a 64 KB budget — the argument is in `specs/vendor.ts`. Creating the
 * file belongs to Drive. Nothing in a tool list says so, and "sheet has no
 * create" is the reasonable conclusion from reading one.
 *
 * And `batchUpdate` is the whole structural-edit surface behind a single
 * `requests` argument that has to stay opaque, because inlining Google's
 * `Request` union costs 2,469 KB. Opaque means the tool cannot enumerate what
 * it does, so the common cases are named here instead.
 */
export const SHEETS_HINTS: Record<string, string> = {
  'spreadsheets.batchUpdate': [
    'This is the structural-edit surface: adding, renaming, reordering, and deleting tabs,',
    'plus formatting, frozen rows, filters, and charts.',
    'The `requests` array takes Google\'s `Request` objects — `addSheet` to create a tab,',
    '`updateSheetProperties` to rename one, `deleteSheet` to remove it,',
    '`repeatCell` to format a range. Its structure is omitted from this schema because',
    'inlining the full union costs megabytes; the shapes are at',
    'https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request.',
    'To change cell *values* rather than structure, use the `values_*` tools instead.',
    'To create a whole new spreadsheet file, use `drive_files_create` with',
    '`mimeType: "application/vnd.google-apps.spreadsheet"` — there is no create tool here.',
  ].join(' '),

  // On the read too, because "how do I make one" is asked while looking at the
  // tool that reads one, and this is the only other tool named `spreadsheets.*`
  // that an agent scanning the list is likely to open.
  'spreadsheets.get': [
    'Reads an existing spreadsheet. To create one, use `drive_files_create` with',
    '`mimeType: "application/vnd.google-apps.spreadsheet"`, then write into it with the',
    '`values_*` tools — this provider edits spreadsheets but does not create the file.',
  ].join(' '),

  'spreadsheets.sheets.copyTo': [
    'Copies one tab into a *different* spreadsheet. To duplicate a tab within the same',
    'file use `batchUpdate` with a `duplicateSheet` request, and to copy the whole file',
    'use `drive_files_copy`.',
  ].join(' '),
};
