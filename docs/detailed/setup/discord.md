# Connecting Discord

```console
$ lanes link connect discord --profile <profile> --target <target>
```

It asks for one thing: a bot token, which you get from Discord's developer portal. Everything
else is choices you make in that portal and an invite link you open once per server.

## What this can and cannot do

Read this part first, because it decides whether the rest is worth your time.

**Discord has no API for acting as your own account.** Automating a user token is "self-botting" —
their terms forbid it and accounts get terminated for it — and the OAuth2 user scopes cover neither
posting to a channel nor reading its history. Every legitimate integration acts as an
*application*, and an application's messages carry an `APP` badge next to the name. There is no
setting, permission, or endpoint that removes it.

What you *can* control is the name and the avatar. Two ways:

- **As the application.** `discord_create_message` posts under the application's own name and
  icon, which you set once in the portal. Set them to your name and photo and posts read as you,
  with the badge.
- **As anything, per message.** `discord_execute_webhook` takes `username` and `avatar_url` on each
  call, so one channel can carry posts under different names. This is the closer match to "post as
  myself" and it needs a webhook, which is a two-call setup per channel. See
  [Posting under your own name](#posting-under-your-own-name).

Reading is the other half, and it has one gate that will waste an afternoon if you miss it: the
**Message Content intent**. Without it every message you read comes back with an empty `content`,
the call still returns `200`, and nothing anywhere says why.

## Why a token rather than OAuth

Discord does have OAuth2, and it does not help. Authorising with the `bot` scope installs your
application into a server, but the credential that then calls the API is the application's *bot
token* — a property of the app, not something the token exchange hands back. So a browser flow
would end with you copying a token out of the portal regardless.

The one scope that returns a usable credential, `webhook.incoming`, is write-only to a single
channel. It cannot read, so it cannot do triage.

That leaves the token you generate yourself — the same conclusion GitHub reached, though for a
reason that no longer applies: GitHub's was a callback port a vendor would not accept, which
[ADR-045](../adr/045-a-redirect-the-vendor-matches-exactly.md) has since fixed. Discord's reason is
about where the credential lives and is not ours to fix
([ADR-033](../adr/033-a-pasted-token-for-an-mcp-server.md),
[ADR-047](../adr/047-a-pasted-token-carries-its-own-scheme.md)).

## The application

1. Open <https://discord.com/developers/applications> and choose **New Application**. The name you
   give it is the name on every post, so name it what you want people to read.
2. On **General Information**, set the icon. That is the avatar on every post. Copy the
   **Application ID** while you are here — the invite link needs it.
3. Open the **Bot** tab. Set the username.
4. Still on **Bot**, under **Privileged Gateway Intents**, switch on **MESSAGE CONTENT**. An
   application in fewer than 10,000 servers can just toggle it — there is no review and no
   verification. Leave `PRESENCE` and `SERVER MEMBERS` off; nothing here uses them.
5. Turn **Public Bot** off, unless you want other people able to add it to their servers.

## The token

On the **Bot** tab, choose **Reset Token** and copy what it shows you. Discord shows it once.

**Paste it with the word `Bot` and a space in front:**

```
Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.GhIjKl.mNoPqRsTuVwXyZ
```

That prefix is not decoration — it is Discord's authentication scheme, the way `Bearer` is most
other vendors'. The stored value goes into the `Authorization` header exactly as you type it, so a
token pasted bare produces a `401` on every call with nothing in it to say what is wrong. If
something is refusing to authenticate, check this first.

The token is stored encrypted at `discord/<connection>` in the credential store, never in config.

## Inviting it to a server

Take the Application ID from step 2 and open:

```
https://discord.com/oauth2/authorize?client_id=<application-id>&scope=bot&permissions=309774593088
```

Pick a server you own and authorise. Repeat per server.

Those permission bits are exactly what the vendored operations need, and no more:

| Permission | Why |
|---|---|
| View Channels | see that a channel exists at all |
| Send Messages | `create_message` |
| Send Messages in Threads | posting into a thread |
| Read Message History | `list_messages`, which is the whole triage read |
| Add Reactions | `add_my_message_reaction` |
| Manage Messages | `create_pin` — Discord puts pinning behind this |
| Create Public Threads | `create_thread_from_message` |
| Manage Webhooks | `create_webhook`, `list_channel_webhooks` |

There is no kick, ban, timeout, role, or channel-management bit in there, and no operation vendored
that could use one.

**A private channel needs the bot added to it separately.** Server-wide permissions do not reach a
channel the bot cannot see — add it under the channel's own permission settings.

## Posting under your own name

`create_message` posts as the application. To post as *you*:

1. `discord_list_channel_webhooks` on the channel. If one is already there, use it — a channel
   holds at most 15 and there is no reason to make a second.
2. `discord_create_webhook` if not. Keep the `id` and `token` it returns.
3. `discord_execute_webhook` with `username` and `avatar_url` set to whatever the post should wear.

**A webhook token is a credential.** Anybody holding it can post to that channel with no other
authentication, and steps 1 and 2 both return it in their response — which means it reaches the
agent, and whatever the agent is talking to. This is recorded as a
[NOT-GUARANTEED row in the security model](../security.md#guarantee-status) rather than glossed
over. It is withheld from the audit log, and it is bounded: one channel, no read access, nothing
else.

To revoke one: the channel's **Integrations → Webhooks** settings, in Discord itself. Deleting the
webhook there invalidates the token immediately.

## Which tools you get

Twenty, out of 242 in Discord's API. Reads: `get_my_user`, `list_my_guilds`, `get_guild`,
`list_guild_channels`, `get_channel`, `list_messages`, `get_message`, `list_pins`,
`list_message_reactions_by_emoji`, `get_active_guild_threads`. Writes: `create_message`,
`update_message`, `delete_message`, `crosspost_message`, `add_my_message_reaction`, `create_pin`,
`create_thread_from_message`. Webhooks: `list_channel_webhooks`, `create_webhook`,
`execute_webhook`.

`connect` grants `discord.*`, which is all twenty — policy has no pattern between a whole provider
and one exact capability. So **the vendored list is the boundary**, and it deliberately excludes
`bulk_delete_messages`, every moderation endpoint, and everything under roles, invites and guild
settings. A test pins the list so a spec refresh cannot widen it quietly.

If you want a narrower connection, deny what you do not want:

```console
$ lanes link policy deny 'discord.delete_message' --profile <profile> --target <target>
$ lanes link policy deny 'discord.create_webhook' --profile <profile> --target <target>
```

Deny beats allow regardless of order, so this holds even though `connect` wrote `discord.*`.

There is no message search: Discord does not offer one to applications. Finding something means
paging `list_messages` per channel with `before`/`after` and filtering yourself.

Attachments are not available. Discord takes files as `multipart/form-data`, which this connector
cannot encode — it does JSON and form-urlencoded.

## Non-interactive

The connection is named by a label you type, because Discord's `/users/@me` cannot be probed with
the scheme this provider uses — so a scripted run has to supply one:

```console
$ lanes link connect discord --profile <profile> --target <target> \
    --display-name "Announcer" --non-interactive
```

The token still has to be in the credential store first:

```console
$ printf 'Bot %s' "$DISCORD_BOT_TOKEN" | \
    lanes link secrets set discord/main --profile <profile> --target <target>
```

Re-running `connect` with the **same** `--display-name` repairs the existing connection. A
different label makes a second one, which is how you end up with `announcer2`.

## What is recorded

Every call, allowed or refused. Snowflake ids are kept — which guild, channel, message, webhook —
along with pagination cursors and limits, so the log can answer where something went.

Message bodies are not. `content`, `embeds`, `components`, `attachments`, `poll` and a thread's
`name` are withheld and appear as type markers, because a log that reproduced them would be a
second copy of the channel.

Two deliberate exceptions:

- `allowed_mentions` is **kept** on everything that posts. It is not content, it is blast radius —
  whether a post was permitted to ping `@everyone` is exactly the thing you want in the log, and it
  is unrecoverable once the message is edited.
- `username` is **kept** on `execute_webhook`. A webhook post is wearing a name that is not the
  application's, and *posted as "Announcer" in channel 123* is the entry's whole point. The
  `webhook_token` beside it is withheld.

## Troubleshooting

**`401` on everything, including `get_my_user`.** The prefix, nine times out of ten — the stored
value must start with `Bot `. Otherwise: a token invalidated by a later **Reset Token**, or a
deleted application. Reset it and re-run `lanes link connect discord --replace`.

**Reads work, every `content` is empty.** The MESSAGE CONTENT intent is off. Bot tab → Privileged
Gateway Intents. It is not a permission on the invite and no error mentions it. Content is always
available for messages that mention the application, messages in DMs with it, and its own
messages — which is why this can look intermittent.

**`403` on one channel, fine elsewhere.** The bot is in the server but not that channel. Add it in
the channel's own permission settings. A private channel does not inherit.

**`crosspost_message` fails.** It only works on an *announcement* channel — `type: 5` from
`list_guild_channels` — and only on a message already posted there. It is rate limited far more
tightly than posting, and it cannot be undone.

**`create_pin` fails with `403`.** Pinning needs Manage Messages, and a channel holds at most 50
pins.

**A webhook post 400s.** Check `username` is 1–80 characters and is not "Clyde" or "Discord", both
of which Discord refuses.
