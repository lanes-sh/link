import { defineProvider } from '#connectivity';

/** Supabase registers us at connect time — nothing for an operator to set up. */
export const supabase = defineProvider({
  id: 'supabase',
  name: 'Supabase',
  description: 'Projects, database schema, SQL, edge functions, and docs, via Supabase\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.supabase.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
