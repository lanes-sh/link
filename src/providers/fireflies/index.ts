import { defineProvider } from '#connectivity';

/** Fireflies registers us at connect time — nothing for an operator to set up. */
export const fireflies = defineProvider({
  id: 'fireflies',
  name: 'Fireflies',
  description: 'Meeting transcripts, summaries, and action items, via Fireflies\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://api.fireflies.ai/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
