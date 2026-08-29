import { defineProvider } from '#connectivity';

/**
 * Yahoo Mail over IMAP.
 *
 * Yahoo requires an app password for IMAP — the account password is refused
 * outright, and has been since Yahoo turned off "less secure app access". The
 * same hosts serve AOL and the other Yahoo-operated domains under their own
 * names, which is why this is one provider rather than a family.
 */
export const yahooMail = defineProvider({
  id: 'yahoo_mail',
  name: 'Yahoo Mail',
  description:
    'Read, search, and send mail in a Yahoo mailbox over IMAP and SMTP, with an app password.',
  connector: {
    kind: 'imap',
    host: 'imap.mail.yahoo.com',
    port: 993,
    smtp: { host: 'smtp.mail.yahoo.com', port: 587, starttls: true },
  },
  auth: { kind: 'basic' },
  identity: { kind: 'connector' },
  setup: {
    summary:
      'Yahoo Mail uses an app password, which is not your Yahoo account password. Yahoo refuses the ' +
      'account password for IMAP entirely, so there is no other route to a Yahoo mailbox here.',
    docs_url: 'https://help.yahoo.com/kb/SLN15241.html',
    steps: [
      'Sign in at https://login.yahoo.com/account/security.',
      'Choose "Generate app password" (it may be under "Other ways to sign in"). Name it "Lanes Link" — the name is the only way to revoke this one later without cutting off your other devices.',
      'Copy the sixteen characters. Yahoo shows them once, in four groups of four; the spaces are cosmetic and it is accepted either way.',
      'You are asked for your full address next, which is the one you sign in with.',
    ],
    troubleshooting:
      'For Yahoo this is almost always the account password used where an app password belongs — Yahoo ' +
      'refuses the account password for IMAP and reports it identically to a wrong one. Generate an app ' +
      'password at https://login.yahoo.com/account/security and re-run: lanes link connect yahoo_mail --replace.',
    prompts: [
      {
        key: 'username',
        label: 'Yahoo address (the full email address)',
        secret: false,
        scope: 'connection' as const,
        field: 'username' as const,
      },
      {
        key: 'password',
        label: 'App password (sixteen characters)',
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
