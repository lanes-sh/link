import { defineProvider } from '#connectivity';

/** Heroku registers us at connect time — nothing for an operator to set up. */
export const heroku = defineProvider({
  id: 'heroku',
  name: 'Heroku',
  description: 'Apps, dynos, add-ons, releases, and logs, via Heroku\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.heroku.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
