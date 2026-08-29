import { defineProvider } from '#connectivity';

/** Airtable registers us at connect time — nothing for an operator to set up. */
export const airtable = defineProvider({
  id: 'airtable',
  name: 'Airtable',
  description: 'Bases, tables, records, fields, and schema, via Airtable\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.airtable.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
