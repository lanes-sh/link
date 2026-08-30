import { defineProvider } from '#connectivity';

/** Where the client the operator registers is kept. */
export const HUBSPOT_APP = 'hubspot';

/**
 * The loopback redirect HubSpot is told about, verbatim.
 *
 * HubSpot matches the whole redirect URL rather than accepting any loopback
 * port, so the port cannot be one the kernel picked at run time — the console
 * was told a number months earlier and the grant is refused with
 * `redirect_uri_mismatch` otherwise. Same arrangement as Reddit's, and the
 * reason `auth.redirect_uri` exists (ADR-045).
 */
const HUBSPOT_REDIRECT_URI = 'http://127.0.0.1:8771/callback';

/**
 * HubSpot, through the server HubSpot runs.
 *
 * No dynamic client registration, so a client has to exist before the browser
 * opens — and HubSpot's is a purpose-built one rather than an ordinary developer
 * app: an "MCP auth app", created inside the account it will read. Until Lanes
 * operates one, that client is the operator's, which is the `reddit` shape.
 *
 * Declaring both endpoints is what takes this off the SDK's flow and onto the
 * one this repository drives, which is what makes the fixed redirect above
 * possible. See ADR-040.
 */
export const hubspot = defineProvider({
  id: 'hubspot',
  name: 'HubSpot',
  description: 'CRM contacts, companies, deals, and engagements, via HubSpot\'s official MCP server.',
  connector: { kind: 'mcp', endpoint: 'https://mcp.hubspot.com' },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: HUBSPOT_APP,
    authorize_url: 'https://mcp.hubspot.com/oauth/authorize/user',
    token_url: 'https://mcp.hubspot.com/oauth/v3/token',
    redirect_uri: HUBSPOT_REDIRECT_URI,
  },
  setup: {
    summary:
      'HubSpot needs an "MCP auth app" of your own, created inside the HubSpot account you want to ' +
      'reach. It is free, it is not the same thing as a public developer app, and it takes a couple ' +
      'of minutes.',
    docs_url: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
    steps: [
      'Sign in to HubSpot and open Development → MCP Auth Apps in the left sidebar, then "Create MCP auth app" at the top right.',
      'Name it "Lanes Link". A description is optional.',
      `For the redirect URL, enter exactly: ${HUBSPOT_REDIRECT_URI} — the whole URL, including the port. HubSpot matches it literally, so a different port here means every sign-in is refused.`,
      'Create the app. You are taken to its details page, which shows the client ID and client secret.',
      'Copy both. They are asked for below, and they are stored encrypted rather than in any config file.',
    ],
    troubleshooting:
      'redirect_uri_mismatch means the URL registered on the app is not the one above — check the port, and that it is 127.0.0.1 rather than localhost, which HubSpot treats as a different string. ' +
      'If the app was created under the wrong HubSpot account, the sign-in succeeds and the tool list is empty: create the MCP auth app inside the account whose CRM you want to reach.',
    prompts: [
      {
        key: 'client_id',
        label: 'HubSpot MCP auth app client ID',
        secret: false,
        scope: 'shared' as const,
        credential_ref: `${HUBSPOT_APP}/client_id`,
      },
      {
        key: 'client_secret',
        label: 'HubSpot MCP auth app client secret',
        secret: true,
        scope: 'shared' as const,
        credential_ref: `${HUBSPOT_APP}/client_secret`,
      },
    ],
  },
});
