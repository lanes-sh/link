import { defineProvider } from '#connectivity';

/** Flagsmith registers us at connect time — nothing for an operator to set up. */
export const flagsmith = defineProvider({
  id: 'flagsmith',
  name: 'Flagsmith',
  description: 'Feature flags, segments, and environments, via Flagsmith\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.flagsmith.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
