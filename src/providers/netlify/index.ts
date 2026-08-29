import { defineProvider } from '#connectivity';

/** Netlify registers us at connect time — nothing for an operator to set up. */
export const netlify = defineProvider({
  id: 'netlify',
  name: 'Netlify',
  description: 'Sites, deploys, functions, and environment variables, via Netlify\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://netlify-mcp.netlify.app/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
