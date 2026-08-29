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
 * OneDrive, through Graph — a drive reached over HTTPS rather than a folder on
 * this machine.
 *
 * The counterpart to `icloud_drive` and the opposite shape: Apple publishes no
 * protocol, so iCloud Drive is the synced folder on a Mac and nothing else;
 * Microsoft publishes an API, so this works from a deployed endpoint that has no
 * filesystem of the operator's at all.
 *
 * Every item operation names a drive, which `me.GetDrive` reports. That is one
 * extra call before the first read and it is Graph's shape rather than a choice
 * here — the `/me/drive/...` shorthand exists but is not in the published
 * OpenAPI as addressable operations.
 */
export const onedrive = defineProvider({
  id: 'onedrive',
  name: 'OneDrive',
  description: 'Browse, search, read, and organise files in OneDrive, via Microsoft Graph.',
  connector: { kind: 'http', base_url: GRAPH_BASE_URL, openapi: specPath('onedrive.v1.json') },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: MICROSOFT_APP,
    // Declared rather than discovered. An `http` connector has no metadata
    // document to read — a REST API does not announce where its authorization
    // server lives — so the two endpoints are part of the manifest.
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_url: MICROSOFT_TOKEN_URL,
    scopes: FILES_SCOPES,
    revoke_url: 'https://account.live.com/consent/Manage',
  },
  identity: MICROSOFT_IDENTITY,
  setup: microsoftSetup('OneDrive', FILES_SCOPES),
  redact: {
    'me.GetDrive': ['select'],
    'drives.GetRoot': ['drive-id', 'select'],
    'drives.GetItems': ['drive-id', 'driveItem-id', 'select'],
    'drives.items.ListChildren': ['drive-id', 'driveItem-id', 'top', 'orderby', 'select'],
    'drives.GetItemsContent': ['drive-id', 'driveItem-id'],
    // Where a file was created, never what it is called — a filename is content,
    // and "Divorce settlement draft.docx" is the whole document.
    'drives.items.CreateChildren': ['drive-id', 'driveItem-id'],
    // Not `q` or `search`: what someone searched their own drive for is content.
    'drives.drive.items.driveItem.search': ['drive-id', 'driveItem-id', 'top', 'orderby', 'select'],
  },
});
