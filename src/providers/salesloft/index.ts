import { defineProvider } from '#connectivity';

/** Salesloft registers us at connect time — nothing for an operator to set up. */
export const salesloft = defineProvider({
  id: 'salesloft',
  name: 'Salesloft',
  description: 'Cadences, people, and sales activity, via Salesloft\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.salesloft.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
