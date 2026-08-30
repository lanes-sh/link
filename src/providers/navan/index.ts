import { defineProvider } from '#connectivity';

/** Navan registers us at connect time — nothing for an operator to set up. */
export const navan = defineProvider({
  id: 'navan',
  name: 'Navan',
  description: 'Trips, bookings, and travel expenses, via Navan\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.navan.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
