import { defineProvider } from '#connectivity';

/** Jam registers us at connect time — nothing for an operator to set up. */
export const jam = defineProvider({
  id: 'jam',
  name: 'Jam',
  description: 'Bug reports, with their console logs, network calls, and repro steps, via Jam\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.jam.dev/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
