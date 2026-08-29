import { defineProvider } from '#connectivity';

/** Cloudflare registers us at connect time — nothing for an operator to set up. */
export const cloudflareObservability = defineProvider({
  id: 'cloudflare_observability',
  name: 'Cloudflare Observability',
  description: 'Workers logs, analytics, and traces, via Cloudflare\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://observability.mcp.cloudflare.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
