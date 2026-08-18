/**
 * Identifiers and shape, never contents.
 *
 * The split is cleaner here than it was for mail. `values` and `data` hold the
 * cells themselves, and `requests` holds the text of a structural edit — that is
 * the spreadsheet, and withholding it is the whole point of the default. What is
 * kept is where and how: which file, which range, and which write mode, without
 * which a write log records that a spreadsheet changed and not where.
 *
 * Reads are listed too, unlike Gmail's block. Gmail withholds its reads because
 * `q` is a search query and the question is the sensitive part; a Sheets read
 * carries no query, only a file id and an A1 range, so there is nothing there to
 * protect. A range does embed a tab name, which is the user's word — that is the
 * one judgement call, made in favour of an audit log that can distinguish
 * reading a cell from reading the sheet.
 *
 * The two writes take `pathRange`, not `range`. A `ValueRange` body carries a
 * `range` of its own, so the generator prefixes both with where they came from,
 * and the plain name matches neither. This block said `range` until the
 * argument-name check in `cli/tools.test.ts` was written — which meant the one
 * thing these entries exist to record, *where* the sheet was written, was the
 * one thing being withheld. The reads keep the plain name because they have no
 * body to collide with.
 */
export const SHEETS_REDACT: Record<string, string[]> = {
  'spreadsheets.get': ['spreadsheetId', 'ranges', 'includeGridData'],
  'spreadsheets.values.get': ['spreadsheetId', 'range', 'majorDimension'],
  'spreadsheets.values.batchGet': ['spreadsheetId', 'ranges', 'majorDimension'],
  'spreadsheets.values.update': ['spreadsheetId', 'pathRange', 'valueInputOption'],
  'spreadsheets.values.batchUpdate': ['spreadsheetId'],
  'spreadsheets.values.append': [
    'spreadsheetId',
    'pathRange',
    'valueInputOption',
    'insertDataOption',
  ],
  'spreadsheets.values.clear': ['spreadsheetId', 'range'],
  'spreadsheets.values.batchClear': ['spreadsheetId', 'ranges'],
  // Every argument, because every argument is an identifier: this operation
  // carries no cell contents at all, and the destination file is the one fact
  // an audit log must not lose — a tab copied into the wrong workbook is the
  // failure worth being able to trace.
  'spreadsheets.sheets.copyTo': ['spreadsheetId', 'sheetId', 'destinationSpreadsheetId'],
  'spreadsheets.batchUpdate': ['spreadsheetId'],
};
