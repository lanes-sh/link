import { defineProvider } from '#connectivity';

/** Hygraph registers us at connect time — nothing for an operator to set up. */
export const hygraph = defineProvider({
  id: 'hygraph',
  name: 'Hygraph',
  description: 'Content entries, models, and schema, via Hygraph\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.hygraph.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
