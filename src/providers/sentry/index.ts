import { defineProvider } from '#connectivity';

/** Sentry registers us at connect time — nothing for an operator to set up. */
export const sentry = defineProvider({
  id: 'sentry',
  name: 'Sentry',
  description: 'Issues, events, stack traces, and releases, via Sentry\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.sentry.dev/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
