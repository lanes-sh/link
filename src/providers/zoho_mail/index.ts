import { defineProvider } from '#connectivity';

/**
 * Zoho Mail over IMAP.
 *
 * The hosts below are Zoho's global ones. An account created in a different
 * data centre answers on a regional hostname instead — `imap.zoho.eu`,
 * `imap.zoho.in`, `imap.zoho.com.au` — and the failure is a connection refused
 * rather than an authentication error, which reads like the password is wrong.
 * A manifest holds one host, so a regional account is a manifest of its own in
 * `providers.d/`: the same two hosts with the suffix changed. `troubleshooting`
 * below is where somebody actually hits this.
 */
export const zohoMail = defineProvider({
  id: 'zoho_mail',
  name: 'Zoho Mail',
  description:
    'Read, search, and send mail in a Zoho mailbox over IMAP and SMTP, with an application-specific password.',
  connector: {
    kind: 'imap',
    host: 'imap.zoho.com',
    port: 993,
    smtp: { host: 'smtp.zoho.com', port: 587, starttls: true },
  },
  auth: { kind: 'basic' },
  identity: { kind: 'connector' },
  setup: {
    summary:
      'Zoho Mail uses an application-specific password when two-factor authentication is on, which ' +
      'is the supported way to reach IMAP. It is not your Zoho account password, and it does not expire.',
    docs_url: 'https://www.zoho.com/accounts/help/multi-factor-authentication/application-specific-passwords.html',
    steps: [
      'Sign in at https://accounts.zoho.com and open Security → App Passwords.',
      'Choose "Generate New Password" and name it "Lanes Link" — the name is the only way to revoke this one later without cutting off your other devices.',
      'Copy the password Zoho shows. It is shown once.',
      'IMAP has to be enabled for the mailbox: Zoho Mail → Settings → Mail Accounts → IMAP Access.',
      'If your account is in a region other than the global one, the hosts differ — see the note below.',
    ],
    troubleshooting:
      'If the connection is refused rather than the password rejected, the account is likely in a regional ' +
      'data centre: imap.zoho.eu, imap.zoho.in, or imap.zoho.com.au rather than imap.zoho.com. Declare those ' +
      'hosts in a manifest of your own under providers.d/ — see docs/detailed/creating-a-provider.md. If the ' +
      'password is rejected, it is usually the Zoho account password used where an application-specific one ' +
      'belongs: generate one at https://accounts.zoho.com and re-run: lanes link connect zoho_mail --replace.',
    prompts: [
      {
        key: 'username',
        label: 'Zoho address (the full email address)',
        secret: false,
        scope: 'connection' as const,
        field: 'username' as const,
      },
      {
        key: 'password',
        label: 'Application-specific password',
        secret: true,
        scope: 'connection' as const,
        field: 'password' as const,
      },
    ],
  },
  redact: {
    // Never the search terms — a query is content, and "who did I email about
    // the diagnosis" is the whole message.
    search_messages: ['mailbox', 'limit', 'unseen', 'flagged'],
    // Identifiers only, and all of them: which mailbox, which message, which
    // attachment. What the file turned out to be — name, size, type, digest —
    // is recorded by the handler through `audit.annotate`, the same way the send
    // path records what it attached.
    get_attachment: ['mailbox', 'uid', 'message_id', 'attachment_id'],
    get_message: ['mailbox', 'uid', 'include_body'],
    mark_messages: ['mailbox', 'add_flags', 'remove_flags'],
    move_messages: ['mailbox', 'destination', 'destination_flag'],
    // Nothing. The recipients and the body are the message, and `attachments`
    // may literally contain a file — what was attached is recorded by the send
    // path itself through `audit.annotate`.
    send_message: [],
  },
});
