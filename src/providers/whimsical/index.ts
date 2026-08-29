import { defineProvider } from '#connectivity';

/** Whimsical registers us at connect time — nothing for an operator to set up. */
export const whimsical = defineProvider({
  id: 'whimsical',
  name: 'Whimsical',
  description: 'Boards, flowcharts, wireframes, and mind maps, via Whimsical\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.whimsical.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
