import { defineProvider } from '#connectivity';

/** Replicate registers us at connect time — nothing for an operator to set up. */
export const replicate = defineProvider({
  id: 'replicate',
  name: 'Replicate',
  description: 'Models, predictions, and deployments, via Replicate\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.replicate.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
