import { defineProvider } from '#connectivity';

/** Wix registers us at connect time — nothing for an operator to set up. */
export const wix = defineProvider({
  id: 'wix',
  name: 'Wix',
  description: 'Sites, stores, bookings, and CMS data, via Wix\'s official MCP server.',
  keywords: ['website', 'cms', 'store', 'page', 'publishing'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.wix.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
