import { defineProvider } from '#connectivity';

/** Grafana registers us at connect time — nothing for an operator to set up. */
export const grafana = defineProvider({
  id: 'grafana',
  name: 'Grafana',
  description: 'Dashboards, datasources, queries, and alert rules, via Grafana\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.grafana.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
