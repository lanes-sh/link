import { defineProvider } from '#connectivity';
import { DRIVE_IDENTITY, GOOGLE_APP, GOOGLE_OAUTH, specPath } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';
import { DRIVE_HINTS } from './hints.ts';
import { DRIVE_REDACT } from './redact.ts';

/** Drive over the REST API. Same reasoning as `gmail` — no preview gate. */
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

export const drive = defineProvider({
  id: 'drive',
  name: 'Google Drive',
  description:
    'Search, read, and export files, and organise the ones this app created — rename, move, trash, copy, and share — via the Drive REST API.',
  connector: {
    kind: 'http',
    base_url: 'https://www.googleapis.com/drive/v3',
    openapi: specPath('drive.v3.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: DRIVE_SCOPES,
    ...GOOGLE_OAUTH,
  },
  identity: DRIVE_IDENTITY,
  setup: googleSetup('Drive', DRIVE_SCOPES),
  redact: DRIVE_REDACT,
  hints: DRIVE_HINTS,
});
