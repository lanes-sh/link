import { GOOGLE_APP } from './oauth.ts';

/**
 * The walkthrough every Google provider prints before asking for anything.
 *
 * Google requires a pre-registered OAuth client — even for Google's own MCP
 * servers. No architecture avoids that; it is their policy, and it is the one
 * piece of setup that could not be deleted.
 *
 * Gmail and Drive share the `google` app, which is why `oauth_apps` exists:
 * every connection of a vendor authorises against the same registered client.
 */
export const googleSetup = (
  product: string,
  scopes: readonly string[],
  options: { preview?: boolean; apis?: readonly string[] } = {},
) => {
  // Which APIs to enable is per product, not global: telling someone connecting
  // Gmail to enable Sheets is advice to grant more than they asked for. Sheets
  // and Docs name Drive as well, because their `identity` block reads
  // `drive/v3/about` — with the Drive API disabled, connecting succeeds and then
  // fails to label the connection.
  const apis =
    options.apis ??
    (options.preview
      ? [
          'gmail.googleapis.com',
          'gmailmcp.googleapis.com',
          'drive.googleapis.com',
          'drivemcp.googleapis.com',
        ]
      : ['gmail.googleapis.com', 'drive.googleapis.com']);

  return {
    summary: `${product} needs a Google Cloud OAuth client that you register yourself. Lanes Link never operates one on your behalf — the credentials stay yours. This is asked once per profile and then covers every Google account you connect.`,
    docs: 'docs/detailed/setup/google.md',
    docs_url: 'https://console.cloud.google.com/auth',
    steps: [
      ...(options.preview
        ? [
            'ENROL IN THE WORKSPACE DEVELOPER PREVIEW FIRST — https://developers.google.com/workspace/preview\n       This provider proxies Google\'s MCP server, which is gated behind it. Without enrolment everything below still succeeds — consent is granted, the tool list is returned — and then every single call answers "The caller does not have permission". Enrolment needs a Google Workspace account; a personal @gmail.com cannot enrol, and should use the plain "' +
              product.toLowerCase() +
              '" provider instead, which talks to the REST API and has no gate.',
          ]
        : []),
      'Create or pick a project at https://console.cloud.google.com',
      `Enable the APIs:\n       gcloud services enable ${apis.join(' ')} --project=YOUR_PROJECT${
        options.preview
          ? '\n       Note there are TWO per product for the MCP path: the service itself and its separate MCP API. Enabling only one produces a 403 whose explanation is buried in the response body.'
          : ''
      }\n       Without gcloud: APIs & Services → Library, and search for each by name.`,
      'The rest is under Google Auth Platform — https://console.cloud.google.com/auth — in this order:',
      '  BRANDING — app name and a support email. Seen by nobody but you.',
      '  AUDIENCE — User type: EXTERNAL (even with a Workspace domain: "Internal" admits only that one domain, so a mix of personal and Workspace accounts needs External). Add every account you will connect under "Test users". LEAVE the status as "Testing".',
      `  DATA ACCESS — where scopes live now. Add:\n       ${scopes.join('\n       ')}\n       Note drive.file is filed under "sensitive" rather than "restricted", so it appears in a different section of that page.`,
      '  CLIENTS — Create OAuth client → type: DESKTOP APP. Google\'s docs say "Web application" with a redirect URI for Claude or Antigravity, because they assume the agent host runs the OAuth. Here the CLI does, on a loopback port — which is also why this stays Desktop even when the server runs on Cloud Run.',
      'Copy the client ID and secret — you are asked for them next.',
      'Not publishing is deliberate: these are restricted scopes, and publishing them means Google verification with a CASA assessment taking months. Testing needs none. The cost is that refresh tokens expire after 7 days, so expect to re-run "lanes link connect" weekly — "lanes link doctor" says which are stale.',
    ],
    prompts: [
      {
        key: 'client_id',
        label: 'Google OAuth client ID',
        secret: false,
        credential_ref: `${GOOGLE_APP}/client_id`,
      },
      {
        key: 'client_secret',
        label: 'Google OAuth client secret',
        secret: true,
        credential_ref: `${GOOGLE_APP}/client_secret`,
      },
    ],
  };
};
