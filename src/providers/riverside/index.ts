import { defineProvider } from '#connectivity';

/** Riverside registers us at connect time — nothing for an operator to set up. */
export const riverside = defineProvider({
  id: 'riverside',
  name: 'Riverside',
  description: 'Recordings, transcripts, and clips, via Riverside\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.riverside.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
