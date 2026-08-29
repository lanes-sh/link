import { defineProvider } from '#connectivity';

/** Mux registers us at connect time — nothing for an operator to set up. */
export const mux = defineProvider({
  id: 'mux',
  name: 'Mux',
  description: 'Video assets, live streams, and playback analytics, via Mux\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.mux.com' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
