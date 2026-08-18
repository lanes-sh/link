import { defineProvider } from '#connectivity';
import { DRIVE_IDENTITY, GOOGLE_APP } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';
import { DRIVE_SCOPES } from '../drive/index.ts';

/**
 * Drive via Google's MCP server. Workspace Developer Preview members only.
 *
 * Same story as Gmail. `drivemcp` advertises `auth/drive` too — full read-write
 * over every file in the account — and granting it did not help either.
 */
export const driveMcp = defineProvider({
  id: 'drive_mcp',
  name: 'Google Drive (Google MCP)',
  description:
    'Search, read, and create files via Google\'s official Drive MCP server. Requires Workspace Developer Preview enrolment — use "drive" otherwise.',
  connector: { kind: 'mcp', endpoint: 'https://drivemcp.googleapis.com/mcp/v1' },
  auth: { kind: 'oauth', registration: 'manual', app: GOOGLE_APP, scopes: DRIVE_SCOPES },
  identity: DRIVE_IDENTITY,
  setup: googleSetup('Drive', DRIVE_SCOPES, { preview: true }),
});
