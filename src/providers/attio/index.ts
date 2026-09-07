import { defineProvider } from '#connectivity';

/** Attio registers us at connect time — nothing for an operator to set up. */
export const attio = defineProvider({
  id: 'attio',
  name: 'Attio',
  description: 'Records, lists, notes, and tasks in the CRM, via Attio\'s official MCP server.',
  keywords: ['crm', 'contact', 'company', 'deal', 'pipeline'],
  connector: { kind: 'mcp', endpoint: 'https://mcp.attio.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
