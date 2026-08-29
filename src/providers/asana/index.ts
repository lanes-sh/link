import { defineProvider } from '#connectivity';

/** Asana registers us at connect time — nothing for an operator to set up. */
export const asana = defineProvider({
  id: 'asana',
  name: 'Asana',
  description: 'Tasks, projects, portfolios, and workspaces, via Asana\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.asana.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
