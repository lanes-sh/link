import { defineProvider } from '#connectivity';
import { FASTMAIL_APP, fastmailSetup } from '../shared/setup.ts';

export const fastmailMail = defineProvider({
  // `fastmail_mail`, not `fastmail`: the bare name is the credential app the
  // three share, so `lanes link connect fastmail` fans out to all of them and
  // asks for the password once. Same arrangement as iCloud.
  id: 'fastmail_mail',
  name: 'Fastmail Mail',
  description:
    'Read, search, and send mail in a Fastmail mailbox over IMAP and SMTP, with an app password that does not expire.',
  connector: {
    kind: 'imap',
    host: 'imap.fastmail.com',
    port: 993,
    smtp: { host: 'smtp.fastmail.com', port: 587, starttls: true },
  },
  auth: { kind: 'basic', app: FASTMAIL_APP },
  identity: { kind: 'connector' },
  setup: fastmailSetup('Fastmail'),
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
