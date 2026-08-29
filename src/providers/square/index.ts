import { defineProvider } from '#connectivity';

/** Square registers us at connect time — nothing for an operator to set up. */
export const square = defineProvider({
  id: 'square',
  name: 'Square',
  description: 'Payments, orders, catalog, inventory, and customers, via Square\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.squareup.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
