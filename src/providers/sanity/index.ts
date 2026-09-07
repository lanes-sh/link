import { defineProvider } from '#connectivity';

/** Sanity registers us at connect time — nothing for an operator to set up. */
export const sanity = defineProvider({
  id: 'sanity',
  name: 'Sanity',
  description: 'Documents, datasets, schema, and content releases, via Sanity\'s official MCP server.',
  keywords: ['cms', 'content', 'document', 'schema', 'publishing'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.sanity.io/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
