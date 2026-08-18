import { READ_BUNDLE, WRITE_BUNDLE, type DiscoveredCapability } from '#connectivity';
import { attachmentsJsonSchema } from '#connectivity/mail';
import {
  OPERATIONS,
  SETTABLE_FLAGS,
  SPECIAL_USE_FLAGS,
  mailboxArgument,
  object,
} from './operations.ts';

/**
 * What an IMAP connection exposes, as data.
 *
 * Fixed rather than discovered: IMAP describes its *extensions* through
 * CAPABILITY but never its operations, so the set is RFC 3501's rather than the
 * vendor's. Two of them are conditional — `MOVE` is an extension a server may
 * not have, and sending needs an SMTP block in the manifest.
 */
export function imapCapabilities(input: {
  readonly supportsMove: boolean;
  readonly canSend: boolean;
}): DiscoveredCapability[] {
  const capabilities: DiscoveredCapability[] = [
        {
          name: OPERATIONS.listMailboxes,
          description:
            'List mailboxes (folders) in the account, with the flags that say what each is for.',
          bundle: READ_BUNDLE,
          inputSchema: object({
            pattern: {
              type: 'string',
              default: '*',
              description: 'IMAP LIST pattern — "*" for everything, "INBOX/*" for one subtree.',
            },
          }),
          target: { operation: OPERATIONS.listMailboxes },
        },
        {
          name: OPERATIONS.searchMessages,
          description:
            'Search a mailbox and return message summaries, most recent first. Reading does not mark anything as read.',
          bundle: READ_BUNDLE,
          inputSchema: object({
            mailbox: mailboxArgument,
            from: { type: 'string', description: 'Substring of the From header.' },
            to: { type: 'string', description: 'Substring of the To header.' },
            subject: { type: 'string', description: 'Substring of the Subject header.' },
            text: { type: 'string', description: 'Substring of headers or body.' },
            since: { type: 'string', description: 'On or after this date (YYYY-MM-DD).' },
            before: { type: 'string', description: 'Before this date (YYYY-MM-DD).' },
            unseen: { type: 'boolean', description: 'Only messages not yet read.' },
            flagged: { type: 'boolean', description: 'Only flagged messages.' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          }),
          target: { operation: OPERATIONS.searchMessages },
        },
        {
          name: OPERATIONS.getMessage,
          description:
            'Fetch one message in full: headers, body text, and a list of its attachments. Does not mark it read.',
          bundle: READ_BUNDLE,
          inputSchema: object(
            {
              mailbox: mailboxArgument,
              uid: { type: 'integer', description: 'UID as search_messages reports it.' },
              include_body: { type: 'boolean', default: true },
            },
            ['uid'],
          ),
          target: { operation: OPERATIONS.getMessage },
        },
        {
          name: OPERATIONS.markMessages,
          description: 'Add or remove flags on messages — read, flagged, answered, draft.',
          bundle: WRITE_BUNDLE,
          inputSchema: object(
            {
              mailbox: mailboxArgument,
              uids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 200 },
              add_flags: { type: 'array', items: { enum: [...SETTABLE_FLAGS] } },
              remove_flags: { type: 'array', items: { enum: [...SETTABLE_FLAGS] } },
            },
            ['uids'],
          ),
          target: { operation: OPERATIONS.markMessages },
        },
      ];


  if (input.supportsMove) {
        capabilities.push({
          name: OPERATIONS.moveMessages,
          description:
            'Move messages to another mailbox — archiving, filing, or marking as junk. ' +
            'Give either destination (an exact name from list_mailboxes) or destination_flag, ' +
            'never both. Prefer the flag: mailbox names are localised and vary by provider, ' +
            'so destination_flag: "\\Junk" is how a message is reported as junk portably.',
          bundle: WRITE_BUNDLE,
          inputSchema: object(
            {
              mailbox: mailboxArgument,
              uids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 200 },
              destination: { type: 'string', description: 'Target mailbox, by exact name.' },
              destination_flag: {
                type: 'string',
                enum: [...SPECIAL_USE_FLAGS],
                description:
                  'Target mailbox by its RFC 6154 special-use attribute, resolved against ' +
                  'what the server advertises. Survives a mailbox being named Spam, Junk, or ' +
                  'Junk E-mail.',
              },
            },
            // `destination` is no longer required, because `destination_flag`
            // satisfies the same need; the handler refuses neither-and-both.
            // JSON Schema could express that with `oneOf`, and does not here:
            // `sanitizeSchema` flattens what it does not recognise, and a
            // constraint that survives to some clients and not others is worse
            // than one enforced in exactly one place.
            ['uids'],
          ),
          target: { operation: OPERATIONS.moveMessages },
        });
      }


  if (input.canSend) {
        capabilities.push({
          name: OPERATIONS.sendMessage,
          description:
            'Send a message, with attachments, filing a copy in the Sent mailbox. Attachments are named by reference — a path, an HTTPS URL, or another message in this mailbox — and this endpoint reads the bytes itself, so never encode a file into the call.',
          bundle: WRITE_BUNDLE,
          inputSchema: object(
            {
              to: { type: 'array', items: { type: 'string' }, minItems: 1 },
              cc: { type: 'array', items: { type: 'string' } },
              bcc: { type: 'array', items: { type: 'string' } },
              subject: { type: 'string' },
              text: { type: 'string' },
              html: { type: 'string' },
              in_reply_to: {
                type: 'string',
                description: 'Message-ID being replied to, which threads the reply.',
              },
              from_name: {
                type: 'string',
                description:
                  "Name to show beside the address, e.g. \"Ada Lovelace\". Defaults to this connection's from_name; without either, recipients see a bare address.",
              },
              attachments: attachmentsJsonSchema,
            },
            ['to', 'subject'],
          ),
          target: { operation: OPERATIONS.sendMessage },
        });
      }

  return capabilities;
}
