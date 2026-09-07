import { defineProvider } from '#connectivity';

/** RudderStack registers us at connect time — nothing for an operator to set up. */
export const rudderstack = defineProvider({
  id: 'rudderstack',
  name: 'RudderStack',
  description: 'Sources, destinations, and event streams, via RudderStack\'s official MCP server.',
  keywords: ['event', 'pipeline', 'analytics', 'customer data', 'tracking'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.rudderstack.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
