import { defineProvider } from '#connectivity';

/** Canva registers us at connect time — nothing for an operator to set up. */
export const canva = defineProvider({
  id: 'canva',
  name: 'Canva',
  description: 'Designs, folders, brand templates, assets, and exports, via Canva\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.canva.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
