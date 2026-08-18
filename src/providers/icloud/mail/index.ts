import { defineProvider } from '#connectivity';
import { ICLOUD_APP, icloudSetup } from '../shared/setup.ts';

export const icloudMail = defineProvider({
  id: 'icloud_mail',
  name: 'iCloud Mail',
  description: 'Read, search, and send mail in an iCloud mailbox over IMAP and SMTP.',
  connector: {
    kind: 'imap',
    host: 'imap.mail.me.com',
    port: 993,
    smtp: { host: 'smtp.mail.me.com', port: 587, starttls: true },
  },
  auth: { kind: 'basic', app: ICLOUD_APP },
  identity: { kind: 'connector' },
  setup: icloudSetup('iCloud Mail'),
  redact: {
    // Opted back in one key at a time; everything unlisted is withheld. Never
    // the search terms — a query is content, and "who did I email about the
    // diagnosis" is the whole message.
    search_messages: ['mailbox', 'limit', 'unseen', 'flagged'],
    get_message: ['mailbox', 'uid', 'include_body'],
    mark_messages: ['mailbox', 'add_flags', 'remove_flags'],
    // `destination_flag` alongside `destination`: they are two spellings of the
    // same fact, and keeping only one means a junk move — the case the flag
    // exists for — logs with no destination at all.
    move_messages: ['mailbox', 'destination', 'destination_flag'],
    // Still nothing, now that this can carry attachments — and *especially* now.
    // The recipients and the body are the message, and `attachments` is the one
    // argument that may literally contain a file, so keeping it verbatim would
    // put base64 in the log. What did get attached is recorded instead by the
    // send path itself, through `audit.annotate`: filename, size, type, SHA-256
    // and where the bytes came from. Identifiers, not content — and with `path`
    // unrestricted, that record is the only trace of which file left the machine.
    send_message: [],
  },
});
