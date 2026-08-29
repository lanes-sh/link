import { defineProvider } from '#connectivity';

/** Shortcut registers us at connect time — nothing for an operator to set up. */
export const shortcut = defineProvider({
  id: 'shortcut',
  name: 'Shortcut',
  description: 'Stories, epics, iterations, and workflows, via Shortcut\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.shortcut.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
