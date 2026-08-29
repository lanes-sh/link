export const FASTMAIL_APP = 'fastmail';

/**
 * Fastmail: one account, three providers, one app password.
 *
 * The same shape as iCloud and for the same reason — mail is IMAP, calendars
 * are CalDAV, and a manifest has one connector — but arrived at from the
 * opposite direction. Apple has no other route; Fastmail has a JMAP API and
 * simply does not need one here, because a single app password can be issued
 * with access to mail, calendars and contacts together, and the three transports
 * this repository already speaks reach all of it.
 *
 * `app: fastmail` resolves all three to one `fastmail/<account>` credential, so
 * the password is typed once. Fastmail lets you narrow an app password to one
 * protocol; if you do, connect the providers you scoped it for and no others —
 * a password scoped to mail authenticates against CalDAV and then finds nothing.
 */
export const fastmailSetup = (product: string) => ({
  summary:
    `${product} uses an app password rather than your Fastmail password, which Fastmail refuses ` +
    `for IMAP, CalDAV and CardDAV. You are asked once: one app password can cover Mail, ` +
    `Calendars and Contacts together, because Fastmail issues it per app rather than per service.`,
  docs_url: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
  steps: [
    'Sign in at https://app.fastmail.com and open Settings → Privacy & Security → Integrations.',
    'Under "App passwords", choose "New app password". Name it "Lanes Link" — the name is the only way to revoke this one later without cutting off your other devices.',
    'For access, pick the set that matches what you are connecting. "Mail (IMAP/SMTP)" covers the mail provider; "Contacts (CardDAV)" and "Calendars (CalDAV)" cover the other two. Choosing all three is what lets you type the password once.',
    'Copy the password Fastmail shows. It is shown once, and it is not your account password.',
    'You are asked for your address next — the full one you sign in with, which may be at fastmail.com or at your own domain.',
  ],
  troubleshooting:
    'For Fastmail this is almost always the account password used where an app password belongs, or an app ' +
    'password scoped to a protocol other than the one being connected — one scoped to Mail alone will not ' +
    'authenticate against CalDAV. Create one at https://app.fastmail.com under Settings → Privacy & Security ' +
    '→ Integrations and re-run: lanes link connect fastmail --replace.',
  prompts: [
    {
      key: 'username',
      label: 'Fastmail address (the full email address)',
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
