import { defineProvider } from '#connectivity';

/** Bright Data registers us at connect time — nothing for an operator to set up. */
export const brightdata = defineProvider({
  id: 'brightdata',
  name: 'Bright Data',
  description: 'Web scraping, search results, and datasets, via Bright Data\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.brightdata.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
