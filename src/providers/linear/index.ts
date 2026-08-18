import { defineProvider } from '#connectivity';

/** Linear, like Notion, registers itself — nothing for an operator to set up. */
export const linear = defineProvider({
  id: 'linear',
  name: 'Linear',
  description: 'Issues, projects, comments, and cycles, via Linear\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.linear.app/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic', scopes: ['read', 'write'] },
  identity: { kind: 'tool', tool: 'get_workspace', field: 'name' },
});
