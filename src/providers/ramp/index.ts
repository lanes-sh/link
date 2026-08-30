import { defineProvider } from '#connectivity';

/** Ramp registers us at connect time — nothing for an operator to set up. */
export const ramp = defineProvider({
  id: 'ramp',
  name: 'Ramp',
  description: 'Cards, transactions, reimbursements, and spend limits, via Ramp\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.ramp.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
