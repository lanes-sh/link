import { defineProvider } from '#connectivity';

/** CircleCI registers us at connect time — nothing for an operator to set up. */
export const circleci = defineProvider({
  id: 'circleci',
  name: 'CircleCI',
  description: 'Pipelines, workflows, jobs, and test results, via CircleCI\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.circleci.com/v1/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
