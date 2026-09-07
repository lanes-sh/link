import { defineProvider } from '#connectivity';

/** Remote registers us at connect time — nothing for an operator to set up. */
export const remote = defineProvider({
  id: 'remote',
  name: 'Remote',
  description: 'Employees, contracts, payroll, and time off, via Remote\'s official MCP server.',
  keywords: ['payroll', 'employment', 'contractor', 'hr', 'onboarding'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.remote.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
