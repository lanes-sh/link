import { defineProvider } from '#connectivity';

/** ClickUp registers us at connect time — nothing for an operator to set up. */
export const clickup = defineProvider({
  id: 'clickup',
  name: 'ClickUp',
  description: 'Tasks, lists, spaces, docs, and time entries, via ClickUp\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.clickup.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
