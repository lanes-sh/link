import { defineProvider } from '#connectivity';

/**
 * Notion supports Dynamic Client Registration, so there is genuinely nothing
 * for an operator to do: we register ourselves with their authorization server
 * at connect time. Browser, approve, done.
 */
export const notion = defineProvider({
  id: 'notion',
  name: 'Notion',
  description: 'Pages, databases, comments, and workspace search, via Notion\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.notion.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
  /**
   * `notion-fetch` answers the id `self` with the workspace and the person.
   *
   * This block did not exist, and the note in its place said Notion exposes no
   * "who am I" tool — that `get-users` leads with integration bots rather than
   * the person and `get-teams` returns teamspaces, so both would produce a
   * confident wrong label. That was true of those two tools and is no longer
   * the whole picture: the hosted server renamed them under a `notion-` prefix
   * and added `notion-fetch`, whose `self` returns the connected workspace's id
   * and name alongside the authenticated user's id, name, type and email.
   * Notion documents it for this exact purpose — labelling a connection after
   * OAuth.
   *
   * The qualifier is not decoration. One person's email is the same email in
   * every workspace they belong to, and the account is what `settleIdentity`
   * matches a reconnect on — so without the workspace beside it, connecting a
   * second workspace would repair the first row and overwrite its credential.
   * Slack carries one for the same reason.
   */
  identity: {
    kind: 'tool',
    tool: 'notion-fetch',
    arguments: { id: 'self' },
    field: 'self.user.email',
    qualifier: 'self.workspace.name',
  },
});
