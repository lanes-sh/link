import { defineProvider } from '#connectivity';

/** Dropbox registers us at connect time — nothing for an operator to set up. */
export const dropbox = defineProvider({
  id: 'dropbox',
  name: 'Dropbox',
  description: 'Files, folders, shared links, and file requests, via Dropbox\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.dropbox.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
