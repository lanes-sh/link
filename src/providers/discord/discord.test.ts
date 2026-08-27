import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discord } from './index.ts';
import { DISCORD_HINTS } from './hints.ts';
import { DISCORD_REDACT } from './redact.ts';

/**
 * What `cli/tools.test.ts` cannot say.
 *
 * That file already measures the generated surface against every http provider
 * at once: legal property names, the size budgets, that each declared hint
 * arrives, that each `redact` key names a real argument. None of it is repeated
 * here.
 *
 * What is left is the part that is a *decision* rather than a measurement — the
 * shape of the auth block, the absence of an identity probe, and above all which
 * operations were vendored. That last one is the security boundary: `connect`
 * writes a single `discord.*` policy rule, so the operation list is the only
 * thing standing between an agent and Discord's moderation endpoints. A list
 * cannot defend itself, so it is pinned here.
 */

const spec = JSON.parse(
  await readFile(join(import.meta.dir, 'specs', 'discord.v10.json'), 'utf8'),
) as {
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, { operationId?: string }>>;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];

const vendored = Object.values(spec.paths)
  .flatMap((item) => Object.entries(item))
  .filter(([method]) => METHODS.includes(method))
  .map(([, operation]) => operation.operationId!)
  .sort();

describe('the vendored operation list', () => {
  test('is exactly these twenty, so adding one is a visible decision', () => {
    // Deliberately spelled out rather than derived. A refresh that picks up a
    // new operation should fail here and be read, not merge quietly — the list
    // *is* the policy, because `discord.*` grants whatever is in it.
    expect(vendored).toEqual([
      'add_my_message_reaction',
      'create_message',
      'create_pin',
      'create_thread_from_message',
      'create_webhook',
      'crosspost_message',
      'delete_message',
      'execute_webhook',
      'get_active_guild_threads',
      'get_channel',
      'get_guild',
      'get_message',
      'get_my_user',
      'list_channel_webhooks',
      'list_guild_channels',
      'list_message_reactions_by_emoji',
      'list_messages',
      'list_my_guilds',
      'list_pins',
      'update_message',
    ]);
  });

  test('excludes moderation and mass deletion, which exist upstream', () => {
    // Every id here is real in Discord's document, so this asserts a choice
    // rather than a typo. `bulk_delete_messages` is the one to watch: it sits
    // beside `delete_message` in the spec and would let one call clear a channel.
    for (const refused of [
      'bulk_delete_messages',
      'delete_channel',
      'ban_user_from_guild',
      'delete_guild_member',
      'update_guild',
      'update_guild_member',
      'create_guild_role',
      'delete_webhook',
      'deprecated_delete_pin',
    ]) {
      expect(vendored).not.toContain(refused);
    }
  });

  test('every operation carries a hint and a redaction rule', () => {
    // Discord describes 17 of its 242 operations, none of them ours, so a hint
    // is not decoration — it is the only description an agent gets. And an
    // operation with no `redact` entry logs nothing but type markers.
    expect(Object.keys(DISCORD_HINTS).sort()).toEqual(vendored);
    expect(Object.keys(DISCORD_REDACT).sort()).toEqual(vendored);
  });
});

describe('the manifest', () => {
  test('reaches the host the vendored spec names', () => {
    expect(discord.connector.kind).toBe('http');
    const base = discord.connector.kind === 'http' ? discord.connector.base_url : '';
    expect(base).toBe(spec.servers[0]!.url);
  });

  test('sends the credential as a raw Authorization header, not as a bearer token', () => {
    // Discord's scheme word is `Bot`, and a bearer credential is assembled as
    // `Bearer <token>` with no way to say otherwise. `header` writes the stored
    // value verbatim, so the scheme travels inside the value the operator pastes.
    expect(discord.auth.kind).toBe('header');
    expect(discord.auth.kind === 'header' ? discord.auth.header : undefined).toBe('Authorization');
  });

  test('asks for the token once, secretly, and spells out the prefix', () => {
    // Only the first prompt's answer is stored for a non-basic credential, so a
    // second prompt would be collected and silently dropped.
    const prompts = discord.setup?.prompts ?? [];
    expect(prompts.map((prompt) => prompt.key)).toEqual(['token']);
    expect(prompts[0]?.scope).toBe('connection');
    expect(prompts[0]?.secret).toBe(true);
    // The whole mitigation for a footgun: a token pasted bare 401s with nothing
    // to read, so the label is where it gets said.
    expect(prompts[0]?.label).toContain('Bot');
    expect(discord.setup?.troubleshooting).toContain('Bot ');
  });

  test('declares no identity, because the probe would send the wrong scheme', () => {
    // `resolveAccount` sends `Authorization: Bearer <stored value>`, which here
    // would be `Bearer Bot MTIz…` — a 401 and a null after a round trip, on
    // every connect. Naming the connection falls to the operator instead.
    expect(discord.identity).toBeUndefined();
  });

  test('tells the operator to switch the message content intent on', () => {
    // Reads succeed without it and return empty bodies, which is the failure
    // nothing else reports. It has to be in the walkthrough.
    const steps = (discord.setup?.steps ?? []).join(' ');
    expect(steps).toContain('MESSAGE CONTENT');
    expect(discord.setup?.troubleshooting).toContain('MESSAGE CONTENT');
  });
});

describe('redaction', () => {
  test('never keeps a webhook token, which is a credential in a path parameter', () => {
    // `execute_webhook` authenticates with a token in its URL. Keeping it would
    // write a reusable channel-posting credential into the audit log in clear.
    for (const [capability, kept] of Object.entries(DISCORD_REDACT)) {
      expect(kept, `${capability} keeps webhook_token`).not.toContain('webhook_token');
    }
  });

  test('withholds message bodies while keeping where the message went', () => {
    for (const posting of ['create_message', 'update_message', 'execute_webhook']) {
      const kept = DISCORD_REDACT[posting]!;
      for (const content of ['content', 'embeds', 'components', 'attachments', 'poll']) {
        expect(kept, `${posting} keeps ${content}`).not.toContain(content);
      }
      // Not content, and the one fact about a post that is unrecoverable once it
      // is edited: whether it was allowed to ping the room.
      expect(kept).toContain('allowed_mentions');
    }

    expect(DISCORD_REDACT['create_message']).toContain('channel_id');
    expect(DISCORD_REDACT['execute_webhook']).toContain('webhook_id');
    // A webhook post deliberately wears a name that is not the app's, so the
    // log is illegible without it.
    expect(DISCORD_REDACT['execute_webhook']).toContain('username');
  });
});
