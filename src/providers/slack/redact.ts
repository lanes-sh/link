/**
 * What survives into the audit log when Slack is written to.
 *
 * The line is the one Gmail draws for mail, because it is the same object: a
 * message someone wrote. Where it went is recorded, what it said is not.
 * `channel_id` is an identifier, `thread_ts` says which conversation, and
 * `message` is the whole of the content — a log that quoted it would be a
 * second copy of everybody's Slack, held somewhere nobody expects one.
 *
 * Keys are the *shortened* names. `shortenName` strips a redundant provider
 * prefix, so the upstream `slack_send_message` is `send_message` here, in
 * policy, and in the audit log. Keying this block on the upstream name would
 * match nothing and withhold everything, silently.
 *
 * The same caveat as GitHub's, and it is worth repeating rather than
 * cross-referencing: a proxied server's capabilities are discovered, not
 * declared, so `cli/tools.test.ts` cannot check these names against a local
 * schema the way it does for every `http` provider. They were read off the
 * tool schemas Slack's server actually publishes rather than guessed, but a
 * rename upstream fails the way that test exists to prevent — the value is
 * withheld and the log reads exactly as it does when redaction is working.
 * `lanes link doctor` reporting capability drift is the signal to re-read this.
 *
 * Some entries name tools the default scope set cannot call. That is
 * deliberate: Slack lists every tool regardless of scope and refuses at call
 * time, so someone who later adds `reactions:write` or `canvases:write` finds
 * the log already correct rather than discovering it is not.
 */
export const SLACK_REDACT: Record<string, string[]> = {
  // Everything except the message. `reply_broadcast` is kept because "replied
  // in a thread" and "replied in a thread and pushed it to the channel" are
  // different acts, and only this argument distinguishes them.
  send_message: ['channel_id', 'thread_ts', 'reply_broadcast', 'unfurl_app_links', 'draft_id'],
  send_message_draft: ['channel_id', 'thread_ts'],
  schedule_message: ['channel_id', 'post_at', 'thread_ts', 'reply_broadcast'],
  // The emoji is kept. It is a name from a fixed vocabulary rather than
  // something anyone typed — the same reading that lets Gmail keep label ids —
  // and an entry saying a message was reacted to without saying how records
  // nothing anyone would look for.
  add_reaction: ['channel_id', 'message_ts', 'emoji'],
  // Nothing. A canvas has no identifier until Slack answers with one, so both
  // arguments are the document: `title` is the author's words and `content` is
  // the whole of it. This is `gmail.send_message`'s position, reached the same
  // way — there is no identifier here to keep, so keeping anything would mean
  // keeping content.
  create_canvas: [],
  // `sections` is withheld along with `content`: each entry carries its own
  // markdown, so keeping the array would keep the document a second time.
  update_canvas: ['canvas_id', 'action', 'section_id'],
};
