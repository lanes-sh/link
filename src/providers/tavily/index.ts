import { defineProvider } from '#connectivity';

/** Tavily registers us at connect time — nothing for an operator to set up. */
export const tavily = defineProvider({
  id: 'tavily',
  name: 'Tavily',
  description: 'Web search and page content extraction, via Tavily\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.tavily.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
