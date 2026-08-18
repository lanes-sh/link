/**
 * Only the organising capabilities, and only their identifiers.
 *
 * The default withholds every value, which is right for the reads — `q` is a
 * search query, and "who did I email about the diagnosis" is the whole message.
 * But it makes a write log useless: it records that a message was modified
 * without recording which one, or into what. These keys are the difference
 * between "something was marked spam" and "this was".
 *
 * Label *ids* are safe to keep and are the point of the entry — `UNREAD`,
 * `SPAM`, `INBOX`, or an opaque `Label_12`. Label *names* are the user's own
 * words, so `labels.create` logs that a label was made and not what it says.
 */
export const GMAIL_REDACT: Record<string, string[]> = {
  'users.messages.modify': ['userId', 'id', 'addLabelIds', 'removeLabelIds'],
  'users.messages.batchModify': ['userId', 'ids', 'addLabelIds', 'removeLabelIds'],
  'users.messages.trash': ['userId', 'id'],
  'users.messages.untrash': ['userId', 'id'],
  'users.threads.modify': ['userId', 'id', 'addLabelIds', 'removeLabelIds'],
  'users.threads.trash': ['userId', 'id'],
  'users.threads.untrash': ['userId', 'id'],
  'users.labels.create': ['userId'],
  // `pathId` for the same reason as `drafts.update` below — the `Label` body
  // carries an `id` too. This said `id` until the argument-name check in
  // `cli/tools.test.ts` was written, which meant every label edit was logged
  // without saying which label.
  'users.labels.update': ['userId', 'pathId'],
  'users.labels.delete': ['userId', 'id'],
  'users.drafts.delete': ['userId', 'id'],
  'users.settings.filters.list': ['userId'],
  'users.settings.filters.delete': ['userId', 'id'],
  // `criteria` kept, which is the same call as `drive.permissions.create`
  // keeping `emailAddress`: a log saying a filter was installed but not against
  // whom has failed at the only question it exists to answer. `action` is the
  // effect — the label ids, and `forward`, which is an address worth naming on
  // the one occasion it is set.
  //
  // The cost, stated rather than hidden: `criteria` also carries `query`,
  // `subject`, and `negatedQuery`, so a filter built on words instead of a
  // sender logs those words — the class Gmail's reads withhold on the "who did
  // I email about the diagnosis" ground. The tiebreak is durability. A search
  // is a question asked once; a filter is a rule that keeps running after the
  // credential stops working, and this log is then the only record of who
  // installed it. `annotate` would express the split properly, but it needs an
  // authored capability and these are generated.
  'users.settings.filters.create': ['userId', 'id', 'criteria', 'action'],
  // Nothing. The recipients and the body *are* the message, and `attachments` is
  // the one argument that may literally contain a file — keeping it verbatim
  // would put base64 in the audit log. What was attached is recorded by the send
  // path itself through `audit.annotate`: filename, size, type, SHA-256, and
  // where the bytes came from. Identifiers, not content.
  //
  // Unprefixed because this capability is authored rather than generated, so its
  // name has no `gmail.` to strip.
  send_message: [],
};
