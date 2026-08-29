import { defineProvider } from '#connectivity';

/** Calendly registers us at connect time — nothing for an operator to set up. */
export const calendly = defineProvider({
  id: 'calendly',
  name: 'Calendly',
  description: 'Scheduled events, invitees, event types, and availability, via Calendly\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.calendly.com' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
