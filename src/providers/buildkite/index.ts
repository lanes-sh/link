import { defineProvider } from '#connectivity';

/** Buildkite registers us at connect time — nothing for an operator to set up. */
export const buildkite = defineProvider({
  id: 'buildkite',
  name: 'Buildkite',
  description: 'Pipelines, builds, jobs, and artifacts, via Buildkite\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.buildkite.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
