import { defineProvider } from '#connectivity';

/** Asana registers us at connect time — nothing for an operator to set up. */
export const asana = defineProvider({
  id: 'asana',
  name: 'Asana',
  description: 'Tasks, projects, portfolios, and workspaces, via Asana\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.asana.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
  /**
   * `email` is not returned by default — `opt_fields` is Asana's whole shape for
   * optional output, and without it this answers a user object with a name and
   * no address. The name would resolve, and would be the wrong thing: two people
   * called the same thing are one account to the reconnect match.
   *
   * Asana registers us dynamically at `mcp.asana.com`, so whether that token is
   * accepted by `app.asana.com/api/1.0` is Asana's business and not documented
   * either way. If it is not, the probe 401s and `connect` asks — which is what
   * it did before this block existed, so the downside is a round trip.
   */
  identity: {
    kind: 'http',
    url: 'https://app.asana.com/api/1.0/users/me?opt_fields=email',
    field: 'data.email',
  },
});
