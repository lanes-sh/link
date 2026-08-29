import { defineProvider } from '#connectivity';

/** Vercel registers us at connect time — nothing for an operator to set up. */
export const vercel = defineProvider({
  id: 'vercel',
  name: 'Vercel',
  description: 'Projects, deployments, build logs, and domains, via Vercel\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.vercel.com' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
