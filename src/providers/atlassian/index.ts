import { defineProvider } from '#connectivity';

/**
 * Jira, Confluence and Compass, through Atlassian's own MCP server.
 *
 * The endpoint is `/v1/mcp/authv2` and the path matters: `/v1/mcp` and
 * `/v1/sse` both answer and neither publishes the protected-resource metadata
 * the SDK discovers from, so a client pointed at either gets a 401 it cannot act
 * on. This one advertises dynamic client registration, which is why there is
 * nothing here for an operator to set up.
 */
export const atlassian = defineProvider({
  id: 'atlassian',
  name: 'Atlassian',
  description:
    'Jira issues, Confluence pages, and Compass components, via Atlassian\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.atlassian.com/v1/mcp/authv2' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});
