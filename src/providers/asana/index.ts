import { defineProvider } from '#connectivity';

/** Asana registers us at connect time — nothing for an operator to set up. */
export const asana = defineProvider({
  id: 'asana',
  name: 'Asana',
  description: 'Tasks, projects, portfolios, and workspaces, via Asana\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.asana.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
  /**
   * No identity block. `GET /users/me?opt_fields=email` is documented and
   * answers `data.email`, and it was written here on that reading — but Asana
   * registers us dynamically at `mcp.asana.com`, and whether that token is
   * accepted by `app.asana.com/api/1.0` is not documented either way.
   *
   * Supabase is why this was taken back out rather than left to fail closed.
   * There, the authorization server *is* the API's own host, which is a much
   * stronger reason to expect the token to work — and `GET /v1/profile` still
   * answered "does not support oauth access yet". An MCP token is its own
   * credential kind until a vendor says otherwise, so this one waits for
   * somebody with an Asana account to try it.
   */
});
