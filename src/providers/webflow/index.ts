import { defineProvider } from '#connectivity';

/** Webflow registers us at connect time — nothing for an operator to set up. */
export const webflow = defineProvider({
  id: 'webflow',
  name: 'Webflow',
  description: 'Sites, pages, CMS collections, and items, via Webflow\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.webflow.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
