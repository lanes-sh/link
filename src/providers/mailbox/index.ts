import { defineProvider } from '#connectivity';
import { HOSTNAME } from '../nextcloud/shared/setup.ts';

/**
 * Any mailbox, over IMAP and SMTP.
 *
 * The generic one, and the reason connection variables were worth building. Every
 * other mail provider here is the same twenty lines with a different pair of
 * hostnames — `icloud_mail`, `gmail_imap`, `fastmail_mail`, `zoho_mail`,
 * `yahoo_mail` — and each exists because a manifest could hold exactly one
 * address. A named provider is still better where there is one: it can carry the
 * vendor's own setup walkthrough, its message-size limit, and the sentence about
 * app passwords that a generic one cannot. This is for everything else — a
 * company Dovecot, a Migadu, a Mailcow, a host nobody has written a manifest for.
 *
 * Two variables rather than one, because the two hosts genuinely differ:
 * submission is conventionally `smtp.` where retrieval is `imap.`, and plenty of
 * servers do neither.
 */
export const mailbox = defineProvider({
  id: 'mailbox',
  name: 'Mailbox (any IMAP server)',
  description:
    'Read, search, and send mail in any IMAP mailbox — a company server, or a host with no provider of its own.',
  connector: {
    kind: 'imap',
    host: '{imap_host}',
    port: 993,
    smtp: { host: '{smtp_host}', port: 587, starttls: true },
  },
  auth: { kind: 'basic' },
  identity: { kind: 'connector' },
  variables: [
    {
      key: 'imap_host',
      label: 'IMAP server',
      description: 'Where mail is read from. Usually imap.<your domain>, on port 993.',
      example: 'imap.example.com',
      pattern: HOSTNAME,
    },
    {
      key: 'smtp_host',
      label: 'SMTP server',
      description: 'Where mail is sent from. Often the same host, often smtp.<your domain>.',
      example: 'smtp.example.com',
      pattern: HOSTNAME,
    },
  ],
  setup: {
    summary:
      'A mailbox on a server this program has no manifest for. It asks for the two hostnames and the ' +
      'login; TLS is required on both, and the ports are the standard 993 and 587. Where your provider ' +
      'has a named entry here — iCloud, Fastmail, Gmail, Zoho, Yahoo — use that instead: it carries the ' +
      'setup steps and the limits this one cannot know.',
    steps: [
      'Find your provider\'s IMAP and SMTP hostnames. They are usually in a page called "IMAP settings" or "Mail client setup".',
      'If the account has two-factor authentication, create an app password for it. Most servers refuse the account password over IMAP once 2FA is on.',
      'This provider assumes IMAP on 993 and SMTP submission on 587 with STARTTLS, which is what almost every host uses. A server on 465, or on a non-standard port, needs a manifest of its own in providers.d/ — see docs/detailed/creating-a-provider.md.',
    ],
    troubleshooting:
      'A connection refused is usually the wrong hostname or a server that wants port 465 rather than 587. ' +
      'A rejected login on the right host is usually an account password where an app password belongs.',
    prompts: [
      {
        key: 'username',
        label: 'Username (usually the full email address)',
        secret: false,
        scope: 'connection' as const,
        field: 'username' as const,
      },
      {
        key: 'password',
        label: 'Password or app password',
        secret: true,
        scope: 'connection' as const,
        field: 'password' as const,
      },
    ],
  },
  redact: {
    search_messages: ['mailbox', 'limit', 'unseen', 'flagged'],
    get_message: ['mailbox', 'uid', 'include_body'],
    mark_messages: ['mailbox', 'add_flags', 'remove_flags'],
    move_messages: ['mailbox', 'destination', 'destination_flag'],
    send_message: [],
  },
});
