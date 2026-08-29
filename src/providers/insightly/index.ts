import { defineProvider } from '#connectivity';

/** Insightly registers us at connect time — nothing for an operator to set up. */
export const insightly = defineProvider({
  id: 'insightly',
  name: 'Insightly',
  description: 'Contacts, organisations, opportunities, and projects, via Insightly\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.insightly.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
