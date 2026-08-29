import { defineProvider } from '#connectivity';
import {
  CALENDAR_SCOPES,
  CONTACTS_SCOPES,
  FILES_SCOPES,
  GRAPH_BASE_URL,
  MAIL_SCOPES,
  MICROSOFT_APP,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_IDENTITY,
  MICROSOFT_TOKEN_URL,
  TODO_SCOPES,
  specPath,
} from '../shared/oauth.ts';
import { microsoftSetup } from '../shared/setup.ts';

/**
 * Read-only, deliberately, and the same call as Google's contacts provider.
 *
 * Graph would allow writes and the vendored spec could carry them. What an
 * address book is for here is making "email Bob" resolve, and `Contacts.Read`
 * is a materially smaller grant than `Contacts.ReadWrite` for a surface nobody
 * has asked to write.
 */
export const outlookContacts = defineProvider({
  id: 'outlook_contacts',
  name: 'Outlook Contacts',
  description: 'Look up an address in Outlook contacts, so "email Bob" resolves. Read-only.',
  connector: { kind: 'http', base_url: GRAPH_BASE_URL, openapi: specPath('outlook-contacts.v1.json') },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: MICROSOFT_APP,
    // Declared rather than discovered. An `http` connector has no metadata
    // document to read — a REST API does not announce where its authorization
    // server lives — so the two endpoints are part of the manifest.
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_url: MICROSOFT_TOKEN_URL,
    scopes: CONTACTS_SCOPES,
    revoke_url: 'https://account.live.com/consent/Manage',
  },
  identity: MICROSOFT_IDENTITY,
  setup: microsoftSetup('Outlook Contacts', CONTACTS_SCOPES),
  redact: {
    // Not `search`: a name is content.
    'me.ListContacts': ['top', 'orderby', 'select'],
    'me.GetContacts': ['contact-id', 'select'],
    'me.ListContactFolders': ['top', 'orderby', 'select'],
  },
});
