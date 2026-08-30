import { defineProvider } from '#connectivity';

/** Datadog registers us at connect time — nothing for an operator to set up. */
export const datadog = defineProvider({
  id: 'datadog',
  name: 'Datadog',
  description: 'Metrics, logs, monitors, incidents, and dashboards, via Datadog\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
