export const NEXTCLOUD_APP = 'nextcloud';

/**
 * A hostname pattern, because the default forbids the dots a hostname is made of.
 *
 * The default exists to stop a value escaping the domain its manifest named —
 * `{site}.zendesk.com` must stay at zendesk.com. Here there is no domain to
 * escape: the manifest is `https://{host}` and the whole address is the
 * operator's to choose, because the whole point is that it is their server.
 *
 * What it still refuses is everything that is not a hostname — no slash, no `@`,
 * no colon, no port. Those are the characters that would turn a host into a URL
 * with a different meaning, and none of them belongs in this value.
 */
export const HOSTNAME = '^[a-z0-9][a-z0-9.-]*[a-z0-9]$';

export const nextcloudSetup = (product: string) => ({
  summary:
    `${product} is on a server you run, so it asks for the address as well as the login. ` +
    `Nextcloud issues app passwords for exactly this — a per-app password that does not expire and ` +
    `can be revoked on its own, without changing the one you sign in with.`,
  docs_url: 'https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html',
  steps: [
    'Sign in to your Nextcloud and open Settings → Personal → Security.',
    'Under "Devices & sessions", enter "Lanes Link" as the app name and choose "Create new app password".',
    'Copy the password it shows. It is shown once, and it is not your account password.',
    'You are asked for the server address next — the hostname you sign in at, without https:// and without a path.',
    'If your Nextcloud lives under a path — cloud.example.com/nextcloud — this provider cannot reach it: the address it builds ends at the host. Declare a manifest of your own in providers.d/ with the full base_url.',
  ],
  troubleshooting:
    'A refused login is usually the account password used where an app password belongs, or a server address ' +
    'typed with https:// or a trailing path — it wants the bare hostname. Create an app password under ' +
    'Settings → Security and re-run: lanes link connect nextcloud --replace.',
  prompts: [
    {
      key: 'username',
      label: 'Nextcloud username',
      secret: false,
      scope: 'connection' as const,
      field: 'username' as const,
    },
    {
      key: 'password',
      label: 'App password',
      secret: true,
      scope: 'connection' as const,
      field: 'password' as const,
    },
  ],
});

/** The one thing that differs per person, and the reason this provider can exist at all. */
export const NEXTCLOUD_HOST = {
  key: 'host',
  label: 'Nextcloud server address',
  description: 'The hostname you sign in at, with no https:// and no path.',
  example: 'cloud.example.com',
  pattern: HOSTNAME,
};
