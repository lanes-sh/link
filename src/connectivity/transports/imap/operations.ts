/**
 * The operation names an IMAP connection exposes, and the argument shapes they
 * share.
 *
 * Their own file because `capabilities.ts` declares them and `index.ts`
 * dispatches on them: a name spelled differently in the two places is a tool
 * that lists and cannot be called.
 */

export const OPERATIONS = {
  listMailboxes: 'list_mailboxes',
  searchMessages: 'search_messages',
  getMessage: 'get_message',
  markMessages: 'mark_messages',
  moveMessages: 'move_messages',
  sendMessage: 'send_message',
} as const;

/** The flags an agent may set. `\Deleted` is deliberately absent. */
export const SETTABLE_FLAGS = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft'] as const;

/**
 * The RFC 6154 special-use attributes a move may name a destination by.
 *
 * A different allowlist from `SETTABLE_FLAGS` and not to be merged with it:
 * these are mailbox attributes reported by LIST, not message flags set by
 * STORE. `\All` is omitted because it is a virtual mailbox — a MOVE into it
 * means nothing — and `\Deleted` is not in this vocabulary at all.
 *
 * This exists because naming a mailbox is not portable. `findSentMailbox`
 * already carried the argument: iCloud spells Sent `Sent Messages`, Gmail
 * `[Gmail]/Sent Mail`, a German Dovecot `Gesendet`. Junk is the same trap with
 * more spellings — `Junk`, `Spam`, `Junk E-mail` — and it is the one an agent
 * asked to "mark this as spam" has to get right, because moving mail to a
 * mailbox that does not exist under that name is how the move silently fails.
 *
 * Deliberately not a `report_junk` operation of its own. That would be
 * `move_messages` under a second name — the `labels.patch` objection. The one
 * thing that would make it more than a rename is the trained signal, and on
 * IMAP that is the `$Junk` keyword plus removing `$NotJunk`; those are
 * keywords, not system flags, so admitting them means widening
 * `SETTABLE_FLAGS` into a different class of thing, with its own argument to
 * make. Until that argument is made, a `report_junk` would advertise a training
 * signal it does not send. The move to `\Junk` is what the server actually
 * learns from, so the move is the honest capability.
 */
export const SPECIAL_USE_FLAGS = ['\\Junk', '\\Archive', '\\Trash', '\\Sent', '\\Drafts'] as const;

export const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

export const mailboxArgument = {
  type: 'string',
  default: 'INBOX',
  description: 'Mailbox name as list_mailboxes reports it.',
};

