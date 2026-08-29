import { defineProvider } from '#connectivity';

/** Contentful registers us at connect time — nothing for an operator to set up. */
export const contentful = defineProvider({
  id: 'contentful',
  name: 'Contentful',
  description: 'Entries, assets, content types, and spaces, via Contentful\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.contentful.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
