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
 * Outlook mail, through Microsoft Graph.
 *
 * The REST half of the Microsoft family, and the reason there is no IMAP one
 * beside it: Microsoft retired basic authentication for Outlook.com IMAP, so an
 * app password is not a route here the way it is for iCloud, Fastmail, or a
 * personal Gmail. Graph with a browser sign-in is what works.
 *
 * `send_message` is a vendored operation rather than authored code, unlike
 * Gmail's — Graph composes the message from JSON, so nothing here has to
 * assemble RFC 2822. What it does not do is attachments: Graph carries those as
 * base64 inside the message, which is the thing ADR-017 exists to avoid, so the
 * field is deliberately absent from the vendored body rather than offered and
 * expensive.
 */
export const outlookMail = defineProvider({
  id: 'outlook_mail',
  name: 'Outlook Mail',
  description:
    'Read, search, file, and send mail in an Outlook or Microsoft 365 mailbox, via Microsoft Graph.',
  connector: {
    kind: 'http',
    // Graph carries its version in the path of the server URL, like Drive and
    // unlike Sheets. `cli/tools.test.ts` checks this equals the spec's own
    // `servers[0].url`.
    base_url: GRAPH_BASE_URL,
    openapi: specPath('outlook-mail.v1.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: MICROSOFT_APP,
    // Declared rather than discovered. An `http` connector has no metadata
    // document to read — a REST API does not announce where its authorization
    // server lives — so the two endpoints are part of the manifest.
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_url: MICROSOFT_TOKEN_URL,
    scopes: MAIL_SCOPES,
    revoke_url: 'https://account.live.com/consent/Manage',
  },
  identity: MICROSOFT_IDENTITY,
  setup: microsoftSetup('Outlook Mail', MAIL_SCOPES),
  // Keyed on the capability name as it is *served* — dots, not underscores.
  // Graph's operationIds are `me.ListMessages` and nothing strips the `me.`,
  // because `shortenName` removes the provider id and the provider is not
  // called "me". A key that misses does not error: it withholds every argument
  // and reads exactly like working redaction.
  redact: {
    // Never `search` or `filter`: a query is content, and "who did I email
    // about the diagnosis" is the whole message.
    'me.ListMessages': ['top', 'orderby', 'select'],
    'me.GetMessages': ['message-id', 'select'],
    'me.UpdateMessages': ['message-id', 'isRead', 'categories', 'flag', 'importance'],
    'me.ListMailFolders': ['top', 'orderby', 'select'],
    'me.messages.ListAttachments': ['message-id', 'top', 'orderby', 'select'],
    'me.messages.GetAttachments': ['message-id', 'attachment-id', 'select'],
    // Nothing. The recipients, the subject, and the body are the message.
    'me.sendMail': ['saveToSentItems'],
  },
});
