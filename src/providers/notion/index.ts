import { defineProvider } from '#connectivity';

/**
 * Notion supports Dynamic Client Registration, so there is genuinely nothing
 * for an operator to do: we register ourselves with their authorization server
 * at connect time. Browser, approve, done.
 */
export const notion = defineProvider({
  id: 'notion',
  name: 'Notion',
  description: 'Pages, databases, comments, and workspace search, via Notion\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.notion.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
  // No identity block on purpose. Notion exposes no "who am I" tool:
  // `get-users` leads with integration bots rather than the person, and
  // `get-teams` returns teamspaces, which are not the workspace and may be in
  // the trash. Both would produce a confident wrong label, so `connect` asks
  // instead — the fallback exists for exactly this.
});
