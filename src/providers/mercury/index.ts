import { defineProvider } from '#connectivity';

/** Mercury registers us at connect time — nothing for an operator to set up. */
export const mercury = defineProvider({
  id: 'mercury',
  name: 'Mercury',
  description: 'Accounts, balances, transactions, and cards, via Mercury\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.mercury.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
