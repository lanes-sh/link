import { defineProvider } from '#connectivity';
import { DRIVE_IDENTITY, GOOGLE_APP, GOOGLE_OAUTH, specPath } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';
import { SHEETS_HINTS } from './hints.ts';
import { SHEETS_REDACT } from './redact.ts';

/**
 * Sheets, because Drive cannot edit a spreadsheet.
 *
 * Drive holds the file and exports a rendering of it; nothing in Drive writes a
 * cell. The nearest thing would be `files.update` with media, which replaces the
 * whole file through import conversion and discards formulas, formatting, tabs,
 * and comments in the process. Cell-level editing exists in exactly one place.
 *
 * Note the `base_url`: Sheets carries its version in the path
 * (`/v4/spreadsheets/...`), where Drive carries it in the host. Copying Drive's
 * shape here yields `/v4/v4/...` and a 404 on every call.
 */

/**
 * Editing a file someone already has, and why that costs a broad scope.
 *
 * `drive.readonly` and `drive.file` are held already and between them nearly
 * cover this: reads of any spreadsheet accept `drive.readonly`, and every Sheets
 * write accepts `drive.file`. But `drive.file` means *files this app created* —
 * its other half, files the user picks, arrives through the Google Picker, and
 * there is no picker on an MCP endpoint. So under those two scopes an agent can
 * build a spreadsheet and maintain it forever, and cannot touch the one someone
 * made in the browser last week. That second case is the request.
 *
 * `spreadsheets` is the only scope that reaches it, and it is the `gmail.modify`
 * argument again, arriving at the same answer for the same reason: there is no
 * narrower grant that does the job, so the choice is this or the feature. It is
 * marked broad in `../shared/scopes.ts` and should stay marked. What bounds it is
 * what bounds Gmail — the token is wide, the tool surface is eight operations,
 * and `lanes link policy deny` narrows that further.
 *
 * `drive.readonly` stays alongside it. `spreadsheets` alone cannot answer
 * `drive/v3/about`, which is how the connection gets labelled with an address.
 */
const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];

export const sheets = defineProvider({
  id: 'sheets',
  name: 'Google Sheets',
  description:
    'Read and edit spreadsheet cells — ranges, appends, and structural changes like tabs, formatting, and frozen rows — via the Sheets REST API.',
  connector: {
    kind: 'http',
    base_url: 'https://sheets.googleapis.com',
    openapi: specPath('sheets.v4.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: SHEETS_SCOPES,
    ...GOOGLE_OAUTH,
  },
  identity: DRIVE_IDENTITY,
  setup: googleSetup('Sheets', SHEETS_SCOPES, {
    apis: ['sheets.googleapis.com', 'drive.googleapis.com'],
  }),
  redact: SHEETS_REDACT,
  hints: SHEETS_HINTS,
});
