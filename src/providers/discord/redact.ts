/**
 * What survives into the audit log when Discord is read or posted to.
 *
 * The default withholds every value, which for a write log means recording that
 * something was posted somewhere without recording where — so every operation
 * here names its identifiers explicitly. Snowflake ids are kept throughout:
 * which guild, which channel, which message, which webhook. Pagination cursors
 * and limits are kept too, because "read 50 messages after this one" is the
 * whole shape of a triage pass and none of it is anybody's content.
 *
 * Message bodies are withheld. `content`, `embeds`, `components`, `attachments`,
 * `poll`, and a thread's `name` are the operator's own words, and a log that
 * reproduces them is a second copy of the channel.
 *
 * Two departures worth stating.
 *
 * `allowed_mentions` is **kept** on every operation that posts. It is not
 * content, it is the blast radius: whether a post was allowed to ping
 * `@everyone` is exactly the fact an operator wants in the log, and it is
 * unrecoverable from anywhere else once the message is edited or deleted.
 *
 * `username` is **kept** on `execute_webhook` and `webhook_token` is not.
 * Keeping the username is what makes the log legible — a webhook post is
 * deliberately wearing a name that is not the app's, and "posted as Ops in
 * channel 123" answers the question the entry exists for. The token is a
 * standalone credential for posting to that channel, so it is withheld by
 * omission and appears as a type marker; `avatar_url` goes the same way for
 * being cosmetic rather than a fact about what happened.
 */
export const DISCORD_REDACT: Record<string, string[]> = {
  // Reads. Everything an argument can be here is an id, a cursor, or a count.
  get_my_user: [],
  list_my_guilds: ['before', 'after', 'limit', 'with_counts'],
  get_guild: ['guild_id', 'with_counts'],
  list_guild_channels: ['guild_id'],
  get_channel: ['channel_id'],
  list_messages: ['channel_id', 'around', 'before', 'after', 'limit'],
  get_message: ['channel_id', 'message_id'],
  list_pins: ['channel_id', 'before', 'limit'],
  list_message_reactions_by_emoji: [
    'channel_id',
    'message_id',
    'emoji_name',
    'after',
    'limit',
    'type',
  ],
  get_active_guild_threads: ['guild_id'],

  // Posting. `content`, `embeds`, `components`, `attachments`, `poll`, and
  // `shared_client_theme` are withheld by omission.
  create_message: [
    'channel_id',
    'allowed_mentions',
    'message_reference',
    'sticker_ids',
    'flags',
    'tts',
    'nonce',
    'enforce_nonce',
  ],
  update_message: [
    'channel_id',
    'message_id',
    'allowed_mentions',
    'sticker_ids',
    'flags',
  ],
  delete_message: ['channel_id', 'message_id'],
  crosspost_message: ['channel_id', 'message_id'],

  // Triage marking. An emoji is a reaction, not private content, and which one
  // was used is the entire meaning of the action.
  add_my_message_reaction: ['channel_id', 'message_id', 'emoji_name'],
  create_pin: ['channel_id', 'message_id'],
  // `name` withheld: a thread title is the operator's words.
  create_thread_from_message: [
    'channel_id',
    'message_id',
    'auto_archive_duration',
    'rate_limit_per_user',
  ],

  // Webhooks. `avatar` on creation is base64 image bytes; withholding it is the
  // same call `gmail.send_message` makes about attachments.
  list_channel_webhooks: ['channel_id'],
  create_webhook: ['channel_id', 'name'],
  execute_webhook: [
    'webhook_id',
    'username',
    'thread_id',
    'allowed_mentions',
    'applied_tags',
    'with_components',
    'wait',
    'flags',
    'tts',
  ],
};
