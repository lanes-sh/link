import { defineProvider } from '#connectivity';

/** monday.com registers us at connect time — nothing for an operator to set up. */
export const monday = defineProvider({
  id: 'monday',
  name: 'monday.com',
  description: 'Boards, items, groups, columns, and updates, via monday.com\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.monday.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
