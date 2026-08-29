import { defineProvider } from '#connectivity';

/** Amplitude registers us at connect time — nothing for an operator to set up. */
export const amplitude = defineProvider({
  id: 'amplitude',
  name: 'Amplitude',
  description: 'Events, charts, cohorts, and user activity, via Amplitude\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.amplitude.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
