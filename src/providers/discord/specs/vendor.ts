/**
 * Vendor a trimmed OpenAPI spec for Discord's v10 HTTP API.
 *
 * Discord publishes an OpenAPI document of its own, which is unusual and
 * welcome, but ships it as a public preview: "subject to breaking changes
 * without advance notice, and should not be used within production
 * environments". Vendoring is what answers that. The committed copy never moves
 * under us, so a breaking change upstream becomes a diff in a refresh commit
 * rather than a provider that stops working — and the surface an operator's bot
 * token can reach stays reviewable.
 *
 *   bun run vendor:discord
 *
 * The pipeline is `src/providers/shared/vendor-spec.ts`. What stays here is what
 * only Discord knows: which operations are worth exposing, and the three shapes
 * in its document that the generator cannot take as written.
 */

import { vendorSpec } from '../../shared/vendor-spec.ts';

const SOURCE = 'https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json';

/**
 * The operations this provider exposes, out of 242 in the document.
 *
 * Curated hard, and the curation is load-bearing rather than tidy: `connect`
 * writes one policy rule, `discord.*`, so an operation vendored here is an
 * operation an agent may call. This list *is* the boundary. Discord's own API
 * would otherwise hand over kick, ban, timeout, role assignment, channel
 * deletion, and guild settings against a server the operator owns.
 *
 * What is deliberately absent, so a later refresh does not quietly add it back:
 * `bulk_delete_messages` (a mass action no announcement workflow needs), every
 * `deprecated_*` pin variant (superseded paths, kept by Discord for old
 * clients), and everything under members, roles, bans, invites, and guild
 * settings.
 */
const READS = [
  // Whose token this is. The first call worth making after connecting, and the
  // one that proves the `Bot ` prefix survived being pasted.
  'get_my_user',
  // Navigation: which servers the bot was added to, what is in them, and what
  // one channel is. An agent cannot post to a channel it cannot name.
  'list_my_guilds',
  'get_guild',
  'list_guild_channels',
  'get_channel',
  // The triage read. Discord exposes no message search to bots, so reading a
  // channel means paging `list_messages` with `after` and `limit`.
  'list_messages',
  'get_message',
  'list_pins',
  'list_message_reactions_by_emoji',
  'get_active_guild_threads',
] as const;

const WRITES = [
  // Posting, as the app.
  'create_message',
  // Editing and retracting one's own announcement. `update_message` is the
  // typo fix; `delete_message` is the retraction, which is why it is here and
  // `bulk_delete_messages` is not.
  'update_message',
  'delete_message',
  // Publishing a message posted in an announcement channel out to the servers
  // that follow it — the one operation that makes an announcement channel worth
  // using rather than an ordinary one.
  'crosspost_message',
  // Triage marking: react to it, pin it, or turn it into a thread. All three
  // are how a human reads back what the agent decided.
  'add_my_message_reaction',
  'create_pin',
  'create_thread_from_message',
] as const;

/**
 * Posting under the operator's own name rather than the app's.
 *
 * Discord has no API for acting as a user account — automating one violates
 * their terms — so an integration posts as an application, and an application's
 * messages carry an `APP` badge that cannot be removed. What *can* be set is the
 * name and avatar, and `execute_webhook` sets them per message. So an
 * announcement can read as the operator while an ordinary reply reads as the
 * integration, from one bot token.
 *
 * The cost is stated in `https://lanes.sh/docs/link/security`: `create_webhook` and
 * `list_channel_webhooks` return the webhook's token in their response, and a
 * webhook token is a standalone credential for posting to that channel.
 */
const WEBHOOKS = ['list_channel_webhooks', 'create_webhook', 'execute_webhook'] as const;

/**
 * Discord's v2 message components, collapsed to open objects.
 *
 * `mcp-from-openapi` inlines `$ref`s, and this union is referenced by four
 * request schemas and again from inside two of its own members — so inlining
 * duplicates the whole tree six times over. There is no wrapper schema to
 * collapse instead; the union is written out inline at each site.
 *
 * Measured, this is the difference between a provider that ships and one that
 * cannot: `execute_webhook` generates a 148.9 KB input schema against a 64 KB
 * per-tool budget, `create_message` 76.2 KB, `update_message` 72.6 KB, and the
 * whole surface 305.4 KB against a 192 KB budget. Opaque brings the worst tool to
 * 10.4 KB and the surface to 34.1 KB.
 *
 * `RichEmbed` is deliberately *not* here. It costs 3.1 KB — 1.6% of the surface
 * budget — and it is how an announcement gets a title, a colour, and fields, so
 * it is the one rich shape worth schematising. Collapsing it instead was
 * measured and moves the worst tool from 148.9 KB to 144.2 KB, which is to say
 * embeds were never the problem.
 */
const OPAQUE = [
  'ActionRowComponentForMessageRequest',
  'ContainerComponentForMessageRequest',
  'FileComponentForMessageRequest',
  'MediaGalleryComponentForMessageRequest',
  'SectionComponentForMessageRequest',
  'SeparatorComponentForMessageRequest',
  'TextDisplayComponentForMessageRequest',
];

await vendorSpec('discord', {
  source: SOURCE,
  outputDirectory: import.meta.dir,
  out: 'discord.v10.json',
  operations: [...READS, ...WRITES, ...WEBHOOKS],
  opaque: OPAQUE,
  opaqueNote:
    'Structure omitted: this union inlines to hundreds of kilobytes. ' +
    'Pass the object as documented at https://discord.com/developers/docs/components/reference.',
  vendoredNote:
    'Trimmed by src/providers/discord/specs/vendor.ts. Committed deliberately: upstream is a public preview that may change without notice, and a spec decides which paths are called with the operator bot token — so it must be reviewable rather than fetched at connect time.',

  // Discord declares path parameters on the path item, not the operation. That
  // is legal, and `mcp-from-openapi`'s validator does not read it: without this
  // the document fails outright with 29 × MISSING_PATH_PARAMETER and generates
  // no tools at all.
  hoistPathParameters: true,

  // `create_message`, `update_message` and `execute_webhook` also offer
  // `multipart/form-data`, whose file fields are named `files[0]`. That is not a
  // legal tool property name, and one illegal name rejects the entire tools list
  // for every provider on the endpoint — so the only thing standing between us
  // and that is the generator preferring JSON of its own accord.
  //
  // The transport can now form-encode as well as JSON-encode (ADR-045), but not
  // multipart, so a multipart branch is unsendable regardless of which one the
  // generator picks. Attachments are unavailable as a result, which is the honest
  // state: ADR-017's machinery is the route to them, not a branch nothing sends.
  requestContentTypes: ['application/json'],

  // `execute_webhook`'s body is a top-level `anyOf` of two complete payload
  // schemas. A union has no `properties` to walk, so the generator emits one
  // argument literally named `body` and the connector then sends
  // `{"body":{"content":"…"}}` where Discord expects `{"content":"…"}`. Nothing
  // in the test suite can see this: the name is legal, the size is fine, the
  // base_url matches — only a live call fails.
  //
  // Naming the branch that is actually wanted flattens it back to 17 real
  // arguments. Lossless: the other branch's properties are a strict subset.
  rewriteRequestBody: {
    execute_webhook: { $ref: '#/components/schemas/IncomingWebhookRequestPartial' },
  },
});
