import { defineProvider } from '#connectivity';

/** Neon registers us at connect time — nothing for an operator to set up. */
export const neon = defineProvider({
  id: 'neon',
  name: 'Neon',
  description: 'Postgres projects, branches, SQL, and docs, via Neon\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.neon.tech/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
