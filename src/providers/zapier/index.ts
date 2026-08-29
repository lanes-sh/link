import { defineProvider } from '#connectivity';

/** Zapier registers us at connect time — nothing for an operator to set up. */
export const zapier = defineProvider({
  id: 'zapier',
  name: 'Zapier',
  description: 'Zaps, and the actions they reach across thousands of apps, via Zapier\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.zapier.com/api/mcp/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
