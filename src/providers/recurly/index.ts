import { defineProvider } from '#connectivity';

/** Recurly registers us at connect time — nothing for an operator to set up. */
export const recurly = defineProvider({
  id: 'recurly',
  name: 'Recurly',
  description: 'Subscriptions, invoices, and accounts, via Recurly\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.recurly.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
