import { defineProvider } from '#connectivity';

/** Close registers us at connect time — nothing for an operator to set up. */
export const close = defineProvider({
  id: 'close',
  name: 'Close',
  description: 'Leads, contacts, opportunities, and activities in the CRM, via Close\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.close.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
