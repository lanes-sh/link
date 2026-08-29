import { defineProvider } from '#connectivity';

/** Algolia registers us at connect time — nothing for an operator to set up. */
export const algolia = defineProvider({
  id: 'algolia',
  name: 'Algolia',
  description: 'Search indices, records, queries, and synonyms, via Algolia\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.algolia.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
