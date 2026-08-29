import { defineProvider } from '#connectivity';

export const BOX_APP = 'box';

/** Matched literally by Box, so it is declared rather than picked at run time. */
const BOX_REDIRECT_URI = 'http://127.0.0.1:8772/callback';

/**
 * Box, through the server Box runs.
 *
 * Box publishes protected-resource metadata and an ordinary authorization-code
 * flow, and no dynamic client registration — so the client is the operator's,
 * and there are two consoles it can come from. The admin route is the one Box
 * prefers and the one that works on a managed enterprise account; the developer
 * route is what an individual has. The steps below take the second, and say so.
 */
export const box = defineProvider({
  id: 'box',
  name: 'Box',
  description: 'Files, folders, and metadata in Box, via Box\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.box.com/' },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: BOX_APP,
    authorize_url: 'https://account.box.com/api/oauth2/authorize',
    token_url: 'https://api.box.com/oauth2/token',
    redirect_uri: BOX_REDIRECT_URI,
  },
  setup: {
    summary:
      'Box needs an OAuth app of your own. On a managed account an administrator can instead add ' +
      'credentials to the Custom Box MCP Server integration in the Admin Console, which is the route ' +
      'Box prefers; these steps take the developer one, which is what an individual account has.',
    docs_url: 'https://developer.box.com/guides/box-mcp/remote/',
    steps: [
      'Sign in at https://app.box.com/developers/console and choose "Create Platform App" → "Custom App".',
      'Pick "User Authentication (OAuth 2.0)" as the authentication method. Not Server Authentication — that one issues a service identity with no access to your own files.',
      `Under Configuration → OAuth 2.0 Redirect URIs, add exactly: ${BOX_REDIRECT_URI} — the whole URL, including the port. Box matches it literally.`,
      'Under Application Scopes, tick at least "Read all files and folders stored in Box"; add write access only if you want the agent to be able to change files.',
      'Save, then copy the Client ID and Client Secret from the Configuration page.',
      'If your Box account is managed by an administrator, the app also has to be authorised in the Admin Console under Apps → Custom Apps Manager before it will work.',
    ],
    troubleshooting:
      'redirect_uri_mismatch means the URI on the app is not the one above — check the port, and 127.0.0.1 rather than localhost. ' +
      'A sign-in that succeeds and then reaches nothing is usually an app awaiting administrator authorisation, or one created with Server Authentication rather than User Authentication.',
    prompts: [
      {
        key: 'client_id',
        label: 'Box app Client ID',
        secret: false,
        scope: 'shared' as const,
        credential_ref: `${BOX_APP}/client_id`,
      },
      {
        key: 'client_secret',
        label: 'Box app Client Secret',
        secret: true,
        scope: 'shared' as const,
        credential_ref: `${BOX_APP}/client_secret`,
      },
    ],
  },
});
