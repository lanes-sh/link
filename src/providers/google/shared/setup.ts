import { GOOGLE_APP } from './oauth.ts';

/**
 * The walkthrough every Google provider prints before asking for anything.
 *
 * Google requires a pre-registered OAuth client — even for Google's own MCP
 * servers. That is their policy and no architecture avoids it, but it does not
 * follow that *you* have to be the one to register it: since ADR-028 the client
 * Lanes operates is the default, and this walkthrough is what `--own-client`
 * opts into. It stays complete, because the people who need it — an
 * organisation that forbids third-party clients, a Workspace "Internal" app —
 * need all of it.
 *
 * Gmail and Drive share the `google` app, which is why `oauth_apps` exists:
 * every connection of a vendor authorises against the same registered client,
 * and declaring that entry is also how a profile says it has one of its own.
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
    summary: `${product} signs in with Google. By default it authorises against the OAuth client Lanes operates, so there is nothing to register and no client secret on this machine — the code is exchanged for a token by the Lanes API, which holds that secret. Pass --own-client to register a client of your own instead; the steps below are that path, asked once per profile and then covering every Google account you connect.`,
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
      '  AUDIENCE — User type: EXTERNAL (even with a Workspace domain: "Internal" admits only that one domain, so a mix of personal and Workspace accounts needs External). Add every account you will connect under "Test users".',
      '  AUDIENCE, again — PUBLISH the app. This is the setting that decides whether your connections survive the week, and it is not the same thing as verification: a client left in "Testing" has every refresh token it issues expired after exactly seven days, and one set to "In production" does not, review pending or not.',
      `  DATA ACCESS — where scopes live now. Add:\n       ${scopes.join('\n       ')}\n       Note drive.file is filed under "sensitive" rather than "restricted", so it appears in a different section of that page.`,
      '  CLIENTS — Create OAuth client → type: DESKTOP APP. Google\'s docs say "Web application" with a redirect URI for Claude or Antigravity, because they assume the agent host runs the OAuth. Here the CLI does, on a loopback port — which is also why this stays Desktop even when the server runs on Cloud Run.',
      'Copy the client ID and secret — you are asked for them next.',
      'What publishing unverified costs, so it is a decision rather than a surprise: everyone you connect sees a "Google hasn\'t verified this app" screen and has to click through Advanced, and the project gains a cap of 100 new users granted these scopes. That cap is for the lifetime of the project and cannot be reset — which does not matter for a client only you use, and matters a great deal for one you intend to hand out.',
      'Verification itself is the other path and a much longer one — restricted scopes mean a review with a security assessment measured in months. It is worth starting and not worth waiting on: publishing above removes the weekly re-authorisation today.',
      'If none of that suits — an organisation that forbids publishing, or a client that must stay in Testing — connect with a service account key instead. It does not expire at all: lanes link connect ' + product.toLowerCase().split(' ')[0] + ' --auth service_account',
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
