import { defineProvider } from '#connectivity';

/** Gamma registers us at connect time — nothing for an operator to set up. */
export const gamma = defineProvider({
  id: 'gamma',
  name: 'Gamma',
  description: 'Presentations and documents, generated and read back, via Gamma\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.gamma.app/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
