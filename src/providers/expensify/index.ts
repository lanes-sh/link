import { defineProvider } from '#connectivity';

/** Expensify registers us at connect time — nothing for an operator to set up. */
export const expensify = defineProvider({
  id: 'expensify',
  name: 'Expensify',
  description: 'Expenses, reports, and receipts, via Expensify\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.expensify.com/mcp/' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
