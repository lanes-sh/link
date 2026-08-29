import { defineProvider } from '#connectivity';

/** Workable registers us at connect time — nothing for an operator to set up. */
export const workable = defineProvider({
  id: 'workable',
  name: 'Workable',
  description: 'Jobs, candidates, and interviews, via Workable\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.workable.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
