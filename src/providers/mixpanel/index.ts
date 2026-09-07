import { defineProvider } from '#connectivity';

/** Mixpanel registers us at connect time — nothing for an operator to set up. */
export const mixpanel = defineProvider({
  id: 'mixpanel',
  name: 'Mixpanel',
  description: 'Events, funnels, retention, and cohorts, via Mixpanel\'s official MCP server.',
  keywords: ['analytics', 'event', 'funnel', 'cohort', 'product analytics'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.mixpanel.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
