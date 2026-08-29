import { defineProvider } from '#connectivity';

/** Vimeo registers us at connect time — nothing for an operator to set up. */
export const vimeo = defineProvider({
  id: 'vimeo',
  name: 'Vimeo',
  description: 'Videos, folders, showcases, and analytics, via Vimeo\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.vimeo.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
