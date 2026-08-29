import { defineProvider } from '#connectivity';

/** Miro registers us at connect time — nothing for an operator to set up. */
export const miro = defineProvider({
  id: 'miro',
  name: 'Miro',
  description: 'Boards, frames, sticky notes, and shapes, via Miro\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.miro.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
