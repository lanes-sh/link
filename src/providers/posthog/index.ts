import { defineProvider } from '#connectivity';

/** PostHog registers us at connect time — nothing for an operator to set up. */
export const posthog = defineProvider({
  id: 'posthog',
  name: 'PostHog',
  description: 'Events, insights, feature flags, and session replays, via PostHog\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.posthog.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
