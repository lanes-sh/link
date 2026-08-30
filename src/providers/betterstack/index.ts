import { defineProvider } from '#connectivity';

/** Better Stack registers us at connect time — nothing for an operator to set up. */
export const betterstack = defineProvider({
  id: 'betterstack',
  name: 'Better Stack',
  description: 'Incidents, monitors, heartbeats, and logs, via Better Stack\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.betterstack.com' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
