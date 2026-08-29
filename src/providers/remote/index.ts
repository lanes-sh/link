import { defineProvider } from '#connectivity';

/** Remote registers us at connect time — nothing for an operator to set up. */
export const remote = defineProvider({
  id: 'remote',
  name: 'Remote',
  description: 'Employees, contracts, payroll, and time off, via Remote\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.remote.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
