/**
 * The documentation, because Discord's spec has none.
 *
 * Their OpenAPI document is machine-generated and carries a `summary` or
 * `description` on 17 of its 242 operations — none of them ours. So
 * `mcp-from-openapi` synthesises `POST /channels/{channel_id}/messages` and that
 * is the *entire* description an agent would otherwise read. A hint is appended
 * to it, which here means a hint is the whole of it.
 *
 * Every operation therefore gets one, including the ones whose names look
 * self-explanatory. Two reasons. The names are self-explanatory to someone who
 * already knows Discord's model, and the model has sharp edges — a channel id is
 * not a channel name, `list_messages` pages backwards, an announcement is only
 * publishable from one kind of channel. And `cli/tools.test.ts` looks each hint
 * up by capability name, so a full set is also the check that all twenty tools
 * generated: a hint keyed to a tool that silently failed to generate fails the
 * suite, which is the one failure the size and shape tests cannot see.
 *
 * Prose costs 3.4 KB of a 192 KB surface budget. It is not the constraint.
 */
export const DISCORD_HINTS: Record<string, string> = {
  get_my_user: [
    'Returns the bot application this token belongs to — its id, username, and discriminator.',
    'Costs nothing and needs no permissions, so it is the call to make first when a connection',
    'is misbehaving: a 401 here means the stored token is wrong or is missing its `Bot ` prefix,',
    'and everything else will fail the same way.',
  ].join(' '),

  list_my_guilds: [
    'The servers this bot has been added to — not the servers you are a member of.',
    'A server the bot was never invited to is invisible here and unreachable by every other',
    'tool, so an empty list means the invite step was missed rather than that you have no servers.',
    'Returns id, name, and your permissions in each. Start here to turn a server name into the',
    'id every other call wants.',
  ].join(' '),

  get_guild: [
    'One server by id: name, description, icon, owner, and feature flags.',
    'Pass `with_counts: true` to also get approximate member and presence counts.',
    'Use this to confirm you have the right server before posting to it.',
  ].join(' '),

  list_guild_channels: [
    'Every channel in a server, which is how a channel *name* becomes the `channel_id`',
    'the posting and reading tools require. Check the `type` field before posting:',
    '0 is a normal text channel, 5 is an announcement channel (the only kind',
    '`crosspost_message` works on), 15 is a forum, and 2 and 13 are voice and stage,',
    'which cannot take messages. `parent_id` is the category a channel sits under.',
  ].join(' '),

  get_channel: [
    'One channel by id — its name, type, topic, and which category it belongs to.',
    'Worth calling before a first post to a channel an agent has not written to before,',
    'to confirm it is the one intended and that it takes messages at all.',
  ].join(' '),

  list_messages: [
    'Read a channel\'s recent messages. This is the triage read, and the only one:',
    'Discord exposes no message search to bot applications, so finding something means',
    'paging this and filtering yourself.',
    'Newest first by default, up to `limit: 100` per call. Page *backwards* through history',
    'with `before` set to the oldest id you have seen; page forward for new arrivals with',
    '`after` set to the newest. `around` centres on one message.',
    'If every `content` comes back empty, the Message Content intent is switched off for',
    'this application — that is a toggle in the developer portal, not a permission on the',
    'invite, and nothing else reports it.',
  ].join(' '),

  get_message: [
    'One message by id, with its author, timestamp, attachments, reactions, and any embeds.',
    'Use it to re-read a single message in full after `list_messages` has narrowed things down,',
    'or to check whether an edit or a reaction landed.',
  ].join(' '),

  list_pins: [
    'The pinned messages in a channel. Pinning is how this integration marks something as',
    'handled or important where a human will see it, so this is the read that shows what',
    'has been marked. Note the path is the current one — Discord also serves a deprecated',
    'pins endpoint that is not exposed here.',
  ].join(' '),

  list_message_reactions_by_emoji: [
    'Who reacted to a message with one specific emoji. Pass a Unicode emoji directly',
    '(`emoji_name: "✅"`); a custom server emoji is `name:id`.',
    'Useful for reading a lightweight vote or acknowledgement off a message rather than',
    'asking people to reply.',
  ].join(' '),

  get_active_guild_threads: [
    'Every thread in a server that is not archived, across all channels at once.',
    'Cheaper than walking channels one at a time when the question is "what conversations',
    'are open right now", which is the usual first step of a triage pass.',
  ].join(' '),

  create_message: [
    'Post a message to a channel, as the bot application — it will carry an APP badge',
    'and the application\'s own name and avatar. To post under your own name instead,',
    'use `execute_webhook`.',
    'For a plain message, pass `content` (up to 2000 characters, Discord-flavoured markdown).',
    'For an announcement, prefer `embeds`: an embed gives you a title, a coloured left border,',
    'a description, and up to 25 name/value `fields`, and it is what makes a post read as',
    'deliberate rather than typed. `color` is a decimal integer, not a hex string —',
    '0x5865F2 is 5793266.',
    'Set `allowed_mentions` explicitly on anything that could ping a room:',
    '`{"parse": []}` suppresses every mention even if the text contains @everyone.',
    'Reply to something by passing `message_reference` with the message id.',
    'Attachments are not available here — files need a multipart request, which Discord accepts',
    'and this connector cannot encode.',
  ].join(' '),

  update_message: [
    'Edit a message this application posted. It cannot edit anyone else\'s, including one',
    'posted through a webhook — that needs the webhook\'s own edit endpoint.',
    'This is the typo fix for an announcement already out. Only the fields you pass are',
    'changed; passing `content` alone leaves existing embeds in place, and clearing an',
    'embed means passing `embeds: []` explicitly.',
    'Discord shows an "edited" marker afterwards, which cannot be suppressed.',
  ].join(' '),

  delete_message: [
    'Delete a message — the retraction, for an announcement that should not have gone out.',
    'Irreversible, and it leaves no trace in the channel for anyone who had not already read it.',
    'The application can always delete its own messages; deleting somebody else\'s needs',
    'Manage Messages in that channel.',
    'There is deliberately no bulk delete here: this removes one message named by id, so',
    'clearing a channel is not something an agent can do in one call.',
  ].join(' '),

  crosspost_message: [
    'Publish a message that was posted in an *announcement* channel out to every server',
    'that follows it. This is what makes an announcement channel worth using: subscribers',
    'see the post in their own server without joining yours.',
    'Only works on channel `type: 5`, and only on a message already posted there — so the',
    'sequence is `create_message` then this, with the id it returned.',
    'Rate limited far more tightly than posting, and it cannot be undone.',
  ].join(' '),

  add_my_message_reaction: [
    'React to a message as this application. The cheapest way to mark a message as seen,',
    'triaged, or categorised — a ✅ or 👀 costs nothing, notifies nobody, and is visible',
    'to everyone reading the channel.',
    'Pass a Unicode emoji directly (`emoji_name: "✅"`); a custom server emoji is `name:id`.',
    'Remove one with the matching delete tool, which is not exposed here.',
  ].join(' '),

  create_pin: [
    'Pin a message to its channel, where it stays visible in the channel\'s pinned list.',
    'The heavier alternative to a reaction for marking something important: a pin is',
    'channel-wide and appears in the header, so it is the right weight for "this is the',
    'announcement that matters" and the wrong weight for routine triage.',
    'Needs Manage Messages. A channel holds at most 50 pins.',
  ].join(' '),

  create_thread_from_message: [
    'Start a thread hanging off an existing message, which is how a post becomes a',
    'discussion without cluttering the channel. `name` is the thread title and is required.',
    '`auto_archive_duration` is in minutes and accepts only 60, 1440, 4320, or 10080.',
    'Use this to route a triaged message somewhere people can talk about it, rather than',
    'replying inline where it scrolls away.',
  ].join(' '),

  list_channel_webhooks: [
    'The webhooks already configured on a channel, with their ids and tokens.',
    'Check here before calling `create_webhook`: a channel accumulates a webhook per call',
    'and there is a limit of 15, so reusing the one you made last time is the difference',
    'between a working integration and a channel full of clutter.',
    'Needs Manage Webhooks. The response includes each webhook\'s token, which is a',
    'credential — see the note on `execute_webhook`.',
  ].join(' '),

  create_webhook: [
    'Create a webhook on a channel, which is what makes posting under your own name',
    'possible. Do this once per channel and keep the id and token; call',
    '`list_channel_webhooks` first to find an existing one rather than making another.',
    '`name` is a fallback label only — the name and avatar that actually appear are the',
    'ones passed per message to `execute_webhook`. `avatar` takes a base64 data URI,',
    'not a URL, and is optional.',
    'Needs Manage Webhooks. The returned `token` is a standalone credential: anybody',
    'holding it can post to this channel without any other authentication.',
  ].join(' '),

  execute_webhook: [
    'Post through a webhook, setting the name and avatar on the message itself.',
    'This is how an announcement appears under your own name rather than the',
    'application\'s: pass `username` and `avatar_url` and the message wears them.',
    'It still carries an APP badge — Discord has no way to remove that, and no API for',
    'posting as a real user account.',
    'Takes the same `content` and `embeds` as `create_message`. Pass `wait: true` to get',
    'the created message back, which is the only way to learn its id.',
    '`thread_id` posts into an existing thread in the webhook\'s channel.',
    'Note what this cannot do: a webhook only posts. It cannot read the channel, and the',
    'message it creates cannot be edited by `update_message` — a webhook message is',
    'editable only through the webhook that sent it.',
  ].join(' '),
};
