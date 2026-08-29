import { defineProvider } from '#connectivity';

/** Rootly registers us at connect time — nothing for an operator to set up. */
export const rootly = defineProvider({
  id: 'rootly',
  name: 'Rootly',
  description: 'Incidents, alerts, retrospectives, and on-call schedules, via Rootly\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.rootly.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
