/**
 * What Gmail's own document does not say about Gmail.
 *
 * Every mail-organising verb an agent is asked for — mark unread, archive, move
 * to a folder, report spam — is the same operation with a different label id,
 * and the generated description for that operation says only that
 * `addLabelIds` is "a list of IDs of labels to add". Nothing names the ids, and
 * nothing says that the ids *are* the feature.
 *
 * The cost of that omission is not a worse tool, it is a tool nobody finds. An
 * operator asked for these four capabilities to be built; all four already
 * existed and had for months. This file is the fix for that, and it is why the
 * text below spells out the label ids rather than pointing at Google's docs:
 * the reader is a model choosing a tool, and a pointer is a page it will not
 * open.
 */
const LABEL_VERBS = [
  'Gmail has no separate verb for read-state, archiving, or spam — each one is a label edit,',
  'and this is the operation that makes it:',
  '`addLabelIds: ["UNREAD"]` marks unread and `removeLabelIds: ["UNREAD"]` marks read;',
  '`removeLabelIds: ["INBOX"]` archives;',
  '`addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"]` reports spam;',
  '`addLabelIds: ["STARRED"]` stars.',
  'Moving a message into a folder is the same shape — add that folder\'s label id and remove',
  '"INBOX" — because a Gmail folder *is* a label. Call `labels_list` for the ids of the',
  'ones the user made; the capitalised ones above are system labels and always exist.',
  'To delete mail, use the `trash` operation rather than a label: it is recoverable and',
  'there is no permanent-delete tool here by design.',
].join(' ');

export const GMAIL_HINTS: Record<string, string> = {
  'users.messages.modify': LABEL_VERBS,
  // The same text, deliberately. A model that finds one of these and not the
  // others should not have to infer that the batch form works identically —
  // and the batch form is the one worth reaching for on a mailbox sweep.
  'users.messages.batchModify': `${LABEL_VERBS} This is the batch form: pass up to 1000 message ids in \`ids\`.`,
  'users.threads.modify': `${LABEL_VERBS} This applies to every message in the thread at once.`,

  // The distinction Gmail's UI draws with two buttons and its API draws not at
  // all. Getting it wrong is silent in both directions: reporting spam when
  // asked to block leaves the sender arriving tomorrow, and installing a filter
  // when asked to report spam leaves a rule nobody remembers creating.
  'users.settings.filters.create': [
    'This is how a sender is blocked, as opposed to reported.',
    'Reporting spam is a one-off label edit on messages that already exist —',
    'use `messages_modify` with `addLabelIds: ["SPAM"]` for that.',
    'A filter is a standing rule applied to mail that has not arrived yet:',
    '`criteria: {from: "someone@example.com"}` with',
    '`action: {addLabelIds: ["TRASH"]}` to bin it on arrival, or',
    '`action: {addLabelIds: ["SPAM"]}` to route it to spam.',
    '`criteria` also matches on `to`, `subject`, `query`, and `hasAttachment`.',
    'The rule keeps running until it is deleted — it outlives this session,',
    'so prefer the one-off label edit unless a standing rule is what was asked for.',
  ].join(' '),
};
