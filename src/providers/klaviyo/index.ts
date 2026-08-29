import { defineProvider } from '#connectivity';

/** Klaviyo registers us at connect time — nothing for an operator to set up. */
export const klaviyo = defineProvider({
  id: 'klaviyo',
  name: 'Klaviyo',
  description: 'Profiles, lists, segments, campaigns, and flows, via Klaviyo\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.klaviyo.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
