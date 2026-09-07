import { defineProvider } from '#connectivity';

/** Apify registers us at connect time — nothing for an operator to set up. */
export const apify = defineProvider({
  id: 'apify',
  name: 'Apify',
  description: 'Actors, runs, datasets, and scraped results, via Apify\'s official MCP server.',
  keywords: ['scraping', 'crawler', 'automation', 'dataset', 'web data'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.apify.com' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
