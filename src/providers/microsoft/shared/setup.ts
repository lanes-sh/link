import { MICROSOFT_APP } from './oauth.ts';

/**
 * The console walkthrough, shared by all five providers.
 *
 * Parameterised by product name and by the permissions that product asks for,
 * because the registration is one app and the consent is per provider — someone
 * connecting only To Do should not be told to tick mail permissions.
 *
 * A registration of the operator's own, with no broker behind it. Microsoft does
 * not offer dynamic client registration, so a client has to exist before the
 * browser opens; until Lanes operates one, that client is theirs. `--own-client`
 * is not a flag here, it is the only route — which is the `reddit` shape, and
 * the reason `setup.prompts` carries `scope: shared` entries rather than a
 * pasted token.
 */
export const microsoftSetup = (product: string, permissions: readonly string[]) => ({
  summary:
    `${product} authorises in a browser against an app registration of your own in Microsoft Entra. ` +
    `Registering one is free and takes a few minutes; it is a public client, so there is no secret ` +
    `to keep. The same registration covers Outlook mail, calendar, contacts, OneDrive and To Do — ` +
    `you do this once, not once per provider.`,
  docs: 'https://lanes.sh/docs/link/connect',
  docs_url: 'https://entra.microsoft.com',
  steps: [
    'Open https://entra.microsoft.com and go to Applications → App registrations → New registration.',
    'Name it "Lanes Link". Under "Supported account types", pick the option that includes personal Microsoft accounts if this is an @outlook.com or @hotmail.com address — the default is work accounts only, and choosing it is what makes a personal account fail at sign-in rather than at registration.',
    'Under "Redirect URI", choose the platform "Mobile and desktop applications" and enter exactly: http://localhost — no port. Microsoft accepts any port on a loopback redirect for this platform, which is what lets connect listen on whichever one is free.',
    'Register, then copy the "Application (client) ID" from the overview page. That is the value asked for below.',
    'Leave "Certificates & secrets" alone. This is a public client: a secret shipped to a program someone runs is not a secret, so none is created and none is asked for.',
    `Permissions are requested at sign-in rather than configured here, so there is nothing to add under "API permissions" first. ${product} asks for: ${permissions.join(', ')}.`,
  ],
  troubleshooting:
    'AADSTS50011 means the redirect URI does not match: the registration needs the platform "Mobile and desktop applications" with http://localhost, not the "Web" platform, which pins the whole URL including the port. ' +
    'AADSTS50020 means the account type is wrong — a personal Microsoft account signing in to a registration made for work accounts only. Change it under Authentication → Supported account types and re-run: lanes link connect <provider> --replace.',
  prompts: [
    {
      key: 'client_id',
      label: 'Application (client) ID',
      secret: false,
      scope: 'shared' as const,
      credential_ref: `${MICROSOFT_APP}/client_id`,
    },
  ],
});
