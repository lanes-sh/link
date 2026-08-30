import { defineProvider } from '#connectivity';

/** Todoist registers us at connect time — nothing for an operator to set up. */
export const todoist = defineProvider({
  id: 'todoist',
  name: 'Todoist',
  description: 'Tasks, projects, sections, labels, and filters, via Todoist\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://ai.todoist.net/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
