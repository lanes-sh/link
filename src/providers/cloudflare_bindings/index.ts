import { defineProvider } from '#connectivity';

/**
 * Cloudflare runs one MCP server per product area rather than one for the
 * account, so this is a sibling of `cloudflare_observability` and not a
 * duplicate of it — bindings and logs are separate grants.
 */
export const cloudflareBindings = defineProvider({
  id: 'cloudflare_bindings',
  name: 'Cloudflare Bindings',
  description: 'Workers KV, R2, D1, and Durable Objects, via Cloudflare\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://bindings.mcp.cloudflare.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
