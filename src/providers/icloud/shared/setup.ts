export const ICLOUD_APP = 'icloud';

/**
 * iCloud: one account, three providers.
 *
 * Apple publishes no REST API and no MCP server for Mail, Calendar, or
 * Contacts. There *is* an OAuth path — shipped October 2025 and used by Outlook
 * — but it is partner-gated, with no scopes published for these services, so an
 * app-specific password over IMAP and DAV is the only route actually open. If
 * that changes, auth is orthogonal to connectivity here: it is a change to those
 * three `auth` blocks and nothing else.
 *
 * Three manifests because a manifest has one connector and mail is a different
 * protocol from calendars — and because that is the better shape anyway.
 * `connect` writes one policy line per provider, so an operator can allow
 * `icloud_calendar.*` while never granting mail. They share `app: icloud`, which
 * resolves all three to the same `icloud/<account>` credential, so the
 * app-specific password is typed exactly once: Apple issues it at *account*
 * scope, so one password genuinely does unlock all three.
 *
 * Reminders and Notes are deliberately absent. Apple moved to-do lists to a
 * private store after iOS 13, and CalDAV now returns either legacy data or
 * tombstones for them; Notes were never exposed. Saying so here is better than
 * letting someone discover it as a bug.
 */
export const icloudSetup = (product: string) => ({
  summary:
    `${product} uses an app-specific password. Your Apple Account password will not work — Apple refuses it ` +
    `for third-party clients — and Lanes Link never sees it. You are asked once: the same password covers ` +
    `Mail, Calendar, and Contacts, because Apple issues it per account rather than per service.`,
  docs: 'https://lanes.sh/docs/link/icloud',
  docs_url: 'https://support.apple.com/en-us/102654',
  steps: [
    'Sign in at https://account.apple.com and open "Sign-In and Security".',
    'Two-factor authentication must be on. Without it Apple does not offer app-specific passwords at all, and the section below simply will not appear.',
    'App-Specific Passwords → Generate. Name it "Lanes Link" — the name is the only way to revoke this one later without cutting off your other devices.',
    'Copy the sixteen characters. Apple shows them once, as xxxx-xxxx-xxxx-xxxx; the hyphens are cosmetic and it is accepted either way.',
    'Note that changing your Apple Account password revokes every app-specific password at once. That is the cause of most sudden iCloud sync failures, and the fix is to generate a new one and run: lanes link connect icloud --replace.',
  ],
  // What a transport cannot say for itself, because it must not know which
  // vendor it is talking to. This is the sentence that used to be hard-coded in
  // three places across `imap` and `dav`.
  //
  // `--replace` rather than a bare re-run: the stored credential is the one
  // that was just refused, and every other spelling of the command finds it
  // already there and reuses it. Advising the loop is how a mistyped password
  // became unrecoverable.
  troubleshooting:
    'For iCloud this is almost always an Apple Account password used where an app-specific password belongs. Generate one at https://account.apple.com and re-run: lanes link connect icloud --replace.',
  prompts: [
    {
      key: 'username',
      label: 'Apple Account (the full email address)',
      secret: false,
      scope: 'connection' as const,
      field: 'username' as const,
    },
    {
      key: 'password',
      label: 'App-specific password',
      secret: true,
      scope: 'connection' as const,
      field: 'password' as const,
    },
  ],
});
