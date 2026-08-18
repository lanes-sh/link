import { defineProvider } from '#connectivity';
import { DRIVE_IDENTITY, GOOGLE_APP, GOOGLE_OAUTH, specPath } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';

/**
 * Docs, on the same reasoning as `sheets`.
 *
 * One difference worth knowing: Docs has no `values`-style shortcut. Every edit,
 * from inserting a word to restyling a heading, is a `batchUpdate` request, so
 * that single operation is the entire write surface rather than the advanced
 * half of it.
 */
const DOCS_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
];

export const docs = defineProvider({
  id: 'docs',
  name: 'Google Docs',
  description:
    'Read a document\'s structure and edit its content — insert, replace, and format text — via the Docs REST API.',
  connector: {
    kind: 'http',
    base_url: 'https://docs.googleapis.com',
    openapi: specPath('docs.v1.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: DOCS_SCOPES,
    ...GOOGLE_OAUTH,
  },
  identity: DRIVE_IDENTITY,
  setup: googleSetup('Docs', DOCS_SCOPES, {
    apis: ['docs.googleapis.com', 'drive.googleapis.com'],
  }),
  // `requests` carries the text being written, so only the document id is kept.
  redact: {
    'documents.get': ['documentId', 'suggestionsViewMode'],
    'documents.batchUpdate': ['documentId'],
  },
});
