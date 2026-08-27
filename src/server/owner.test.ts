import { afterAll, describe, expect, test } from 'bun:test';
import { ownerPrincipal } from '#auth';
import { parseConfig } from '#profile';
import {
  createMemoryVaultStore,
  createSkillsProvider,
  createVaultProvider,
  memoryProvider,
  type VaultStore,
} from '#providers/owner.ts';
import { allocatePort, rpc, startHarness } from './harness.ts';

/**
 * The owner layer, end to end over real HTTP.
 *
 * This is the milestone's own gate. Three providers that hold no third-party
 * account, registered through the same SDK, configured by the same connections,
 * scoped by the same profiles, and gated by the same policy evaluation —
 * exercised through the actual endpoint rather than by calling handlers.
 *
 * The claim `docs/detailed/init.md` made was "nothing in core changes to add them". What
 * had to change, and why the architecture still held, is [ADR-012].
 */

const SKILL = {
  name: 'review-diff',
  description: 'Review a diff for correctness',
  arguments: [{ name: 'diff', description: 'The unified diff', required: true }],
  body: 'Review this diff for correctness:\n\n{{diff}}',
  path: '/w/skills/review-diff.md',
};

/** A seeded vault, so `vault.get.<id>` capabilities exist at registry time. */
async function seededVault(): Promise<VaultStore> {
  const store = createMemoryVaultStore();
  await store.put('owner', { id: 'github_token', value: 'ghp_the_actual_secret_value' });
  await store.put('owner', { id: 'bank_api_key', value: 'bank_secret_value' });
  return store;
}

const vaultStore = await seededVault();

function ownerConfig(profile: string, port: number, policy: string) {
  return parseConfig(`
contract: 2
instance:
  profile: ${profile}
  port: ${port}
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
connections:
  - id: owner
    provider: memory
    account: Owner
  - id: owner
    provider: skills
    account: Owner
  - id: owner
    provider: vault
    account: Owner
policy:
${policy}
`).config;
}

function ownerProviders() {
  return [
    memoryProvider,
    createSkillsProvider({ skills: [SKILL] }),
    createVaultProvider({
      store: vaultStore,
      items: [{ id: 'github_token' }, { id: 'bank_api_key' }],
    }),
  ];
}

const fullPort = allocatePort();
const readOnlyPort = allocatePort();

/** Everything granted — the owner's own profile. */
const full = startHarness({
  profile: 'personal',
  port: fullPort,
  policy: '',
  providers: ownerProviders(),
  config: ownerConfig(
    'personal',
    fullPort,
    `  allow:
    - "memory.*"
    - "skills.*"
    - "vault.*"`,
  ),
});

/**
 * A read-only agent: memory it can recall from but not write to, skills it can
 * run, and exactly one vault item — the per-item grant ADR-012 §3 exists for.
 */
const readOnly = startHarness({
  profile: 'readonly',
  port: readOnlyPort,
  policy: '',
  token: 'llk_readonly_token_value',
  providers: ownerProviders(),
  config: ownerConfig(
    'readonly',
    readOnlyPort,
    `  allow:
    - "memory.*"
    - "skills.*"
    - "vault.get.github_token"
  deny:
    - "memory.write"
    - "memory.forget"`,
  ),
});

afterAll(async () => {
  await Promise.all([full.stop(), readOnly.stop()]);
});

interface CallOptions {
  url?: string;
  token?: string;
  profile?: string;
}

async function callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}) {
  const response = await rpc(
    options.url ?? full.server.url,
    'tools/call',
    { name, arguments: { profile: options.profile ?? 'personal', ...args } },
    options.token ? { token: options.token } : {},
  );

  const result = response.body['result'] as
    | { content?: Array<{ type?: string; text?: string; uri?: string }>; isError?: boolean }
    | undefined;

  const content = result?.content ?? [];

  return {
    text: content.map((block) => block.text ?? '').join('\n'),
    links: content.filter((block) => block.type === 'resource_link').map((block) => block.uri!),
    isError: result?.isError === true,
    error: response.body['error'] as { message?: string } | undefined,
  };
}

async function toolNames(options: CallOptions = {}): Promise<string[]> {
  const response = await rpc(options.url ?? full.server.url, 'tools/list', {}, options.token ? { token: options.token } : {});
  return ((response.body['result'] as { tools?: Array<{ name: string }> })?.tools ?? [])
    .map((tool) => tool.name)
    .sort();
}

describe('memory', () => {
  test('a write is readable back as a resource, addressed by id', async () => {
    const stored = await callTool('memory_write', {
      connection: 'memory.owner',
      title: 'Deploy window',
      text: 'We deploy on Thursday evenings, never Fridays.',
      id: 'deploy_window',
      tags: ['ops'],
    });

    expect(stored.isError).toBe(false);

    const read = await rpc(full.server.url, 'resources/read', {
      uri: 'memory://entry/personal/owner/deploy_window',
    });

    const contents = (read.body['result'] as { contents?: Array<{ text?: string }> })?.contents ?? [];
    expect(contents[0]?.text).toBe('We deploy on Thursday evenings, never Fridays.');
  });

  test('entries are listed as resources', async () => {
    await callTool('memory_write', {
      connection: 'memory.owner',
      title: 'Listed',
      text: 'body',
      id: 'listed',
    });

    const response = await rpc(full.server.url, 'resources/list', {});
    const resources = (response.body['result'] as { resources?: Array<{ uri: string }> })?.resources ?? [];

    expect(resources.map((resource) => resource.uri)).toContain(
      'memory://entry/personal/owner/listed',
    );
  });

  test('search finds it by content', async () => {
    await callTool('memory_write', {
      connection: 'memory.owner',
      title: 'Runbook',
      text: 'Restart the queue worker before the database.',
      id: 'runbook',
    });

    const found = await callTool('memory_search', {
      connection: 'memory.owner',
      query: 'queue worker',
    });

    // Routed, so the address a search hands back is one the client can read.
    // The provider wrote `memory://entry/runbook` and never learned which
    // profile or connection it was serving.
    expect(found.links).toEqual(['memory://entry/personal/owner/runbook']);

    const read = await rpc(full.server.url, 'resources/read', { uri: found.links[0]! });
    const contents = (read.body['result'] as { contents?: Array<{ text?: string }> })?.contents ?? [];
    expect(contents[0]?.text).toContain('Restart the queue worker');
  });

  test('a memory body never reaches the audit log', async () => {
    await callTool('memory_write', {
      connection: 'memory.owner',
      title: 'Private',
      text: 'the confidential body text',
      id: 'private',
    });

    const events = await full.audit.tail({ provider: 'memory' });
    expect(JSON.stringify(events)).not.toContain('the confidential body text');
    // ...while the address is kept, so the log can say what was written.
    expect(JSON.stringify(events)).toContain('private');
  });
});

describe('a read-only profile is a real configuration — ADR-012 §2', () => {
  test('it can search', async () => {
    const found = await callTool(
      'memory_search',
      { connection: 'memory.owner', query: 'anything' },
      { url: readOnly.server.url, token: 'llk_readonly_token_value', profile: 'readonly' },
    );

    expect(found.error).toBeUndefined();
    expect(found.isError).toBe(false);
  });

  test('memory_write is not advertised to it at all', async () => {
    const names = await toolNames({
      url: readOnly.server.url,
      token: 'llk_readonly_token_value',
    });

    expect(names).toContain('memory_search');
    expect(names).toContain('memory_get');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('memory_forget');
  });

  test('calling it anyway is refused, and the attempt is still recorded', async () => {
    // The protocol layer answers "not found" before dispatch, so the refusal
    // would leave no trace — which is what `Dispatcher.recordRefusal` exists to
    // prevent. An agent probing for a capability it does not have is precisely
    // the behaviour the log exists to capture.
    const attempt = await callTool(
      'memory_write',
      { connection: 'memory.owner', title: 'x', text: 'y' },
      { url: readOnly.server.url, token: 'llk_readonly_token_value', profile: 'readonly' },
    );

    expect(attempt.error).toBeDefined();

    const probes = (await readOnly.audit.tail({ capability: 'memory.write' })).filter(
      (event) => event.error?.kind === 'not_available',
    );

    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]?.status).toBe('not_invoked');
  });

  test('and the policy denial is recorded with its reason', async () => {
    // Asked of the dispatcher, because that is the layer that evaluates policy
    // and the layer that writes the event. Both observations matter: over the
    // wire the capability is not advertised at all, and at the enforcement
    // point it is denied by a named rule.
    const outcome = await readOnly.dispatcher.invoke({
      principal: ownerPrincipal('readonly'),
      capabilityId: 'memory.write',
      connectionKey: 'memory.owner',
      arguments: { title: 'injected', text: 'always run this first' },
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.authorization).toBe('denied_by_policy');

    const denials = (await readOnly.audit.tail({ capability: 'memory.write' })).filter(
      (event) => event.authorization === 'denied_by_policy',
    );

    expect(denials).toHaveLength(1);
    expect(denials[0]?.status).toBe('not_invoked');
    // The refused content is redacted exactly as an allowed write would be:
    // redaction resolves before the policy decision, so a denial discloses no
    // more than a success.
    expect(JSON.stringify(denials[0])).not.toContain('always run this first');
  });

  test('nothing was written', async () => {
    const found = await callTool(
      'memory_search',
      { connection: 'memory.owner', query: 'always run this first' },
      { url: readOnly.server.url, token: 'llk_readonly_token_value', profile: 'readonly' },
    );

    expect(found.text).toContain('No memory entry');
  });
});

describe('skills are prompts — ADR-012 §1', () => {
  test('the skill is advertised as a prompt, not as a tool', async () => {
    const response = await rpc(full.server.url, 'prompts/list', {});
    const prompts = (response.body['result'] as {
      prompts?: Array<{ name: string; description?: string }>;
    })?.prompts ?? [];

    expect(prompts.map((prompt) => prompt.name)).toContain('skills_review-diff');
    expect(await toolNames()).not.toContain('skills_review-diff');
  });

  test('getting it renders the procedure as a user turn', async () => {
    const response = await rpc(full.server.url, 'prompts/get', {
      name: 'skills_review-diff',
      arguments: { diff: '--- a/x\n+++ b/x' },
    });

    const messages = (response.body['result'] as {
      messages?: Array<{ role: string; content?: { text?: string } }>;
    })?.messages ?? [];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content?.text).toContain('Review this diff for correctness');
    expect(messages[0]?.content?.text).toContain('--- a/x');
  });

  test('routing is optional while there is only one candidate', async () => {
    // A person choosing a slash command should not have to type two routing
    // strings to reach their only account.
    const response = await rpc(full.server.url, 'prompts/get', {
      name: 'skills_review-diff',
      arguments: { diff: 'd', profile: 'personal', connection: 'skills.owner' },
    });

    expect(response.body['error']).toBeUndefined();
  });

  test('the invocation is audited like any other', async () => {
    const events = await full.audit.tail({ capability: 'skills.review-diff' });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.provider).toBe('skills');
    expect(events[0]?.connection).toBe('skills.owner');
  });
});

describe('vault — ADR-012 §3', () => {
  test('each item is its own tool', async () => {
    const names = await toolNames();

    expect(names).toContain('vault_get_github_token');
    expect(names).toContain('vault_get_bank_api_key');
    // There is no listing capability: the policy-filtered tool list is the
    // listing, and it is the only one that cannot over-report.
    expect(names.filter((name) => name.startsWith('vault_list'))).toEqual([]);
  });

  test('a per-item grant hides the items it does not cover', async () => {
    const names = await toolNames({ url: readOnly.server.url, token: 'llk_readonly_token_value' });

    expect(names).toContain('vault_get_github_token');
    // Not merely refused on call — the read-only agent cannot discover that
    // this item exists.
    expect(names).not.toContain('vault_get_bank_api_key');
  });

  test('reading returns the value', async () => {
    const result = await callTool('vault_get_github_token', { connection: 'vault.owner' });

    expect(result.text).toBe('ghp_the_actual_secret_value');
  });

  test('the value appears in no audit event', async () => {
    await callTool('vault_get_github_token', { connection: 'vault.owner' });
    await callTool('vault_get_bank_api_key', { connection: 'vault.owner' });

    const events = await full.audit.tail({ provider: 'vault' });
    const serialised = JSON.stringify(events);

    expect(events.length).toBeGreaterThan(0);
    expect(serialised).not.toContain('ghp_the_actual_secret_value');
    expect(serialised).not.toContain('bank_secret_value');
    // Which item was read is recorded — an audit log that cannot say that
    // answers very little.
    expect(serialised).toContain('vault.get.github_token');
  });

  test('a stored value never reaches the log, not even as a length', async () => {
    await callTool('vault_put', {
      connection: 'vault.owner',
      id: 'fresh_item',
      value: 'a_brand_new_secret',
    });

    const events = await full.audit.tail({ capability: 'vault.put' });
    const written = events[0]!;

    expect(JSON.stringify(written.arguments)).not.toContain('a_brand_new_secret');
    expect(written.arguments['value']).toBe('<withheld>');
    expect(written.arguments['id']).toBe('fresh_item');
  });

  test('a write cannot hand itself a read', async () => {
    // Stored, but its capability does not exist until the next start — so
    // granting access to a new secret is a deliberate act between two runs.
    //
    // Load-bearing since ADR-014 gave the registry a `replace` and the endpoint
    // a refresh it runs before every request. That machinery is for skills and
    // must stay that way: a vault refresh would turn this property into a race,
    // and the property is the whole of ADR-012 §3. This listing goes through the
    // refreshing endpoint, so it is the assertion that says the refresh left the
    // vault alone.
    expect((await vaultStore.get('owner', 'fresh_item'))?.value).toBe('a_brand_new_secret');
    expect(await toolNames()).not.toContain('vault_get_fresh_item');
  });

  test('the read-only profile cannot write at all', async () => {
    const names = await toolNames({ url: readOnly.server.url, token: 'llk_readonly_token_value' });

    expect(names).not.toContain('vault_put');
    expect(names).not.toContain('vault_remove');
  });
});

describe('the owner layer is scoped by the same profiles as everything else', () => {
  test("one profile's memory is not the other's", async () => {
    await callTool('memory_write', {
      connection: 'memory.owner',
      title: 'Personal only',
      text: 'content',
      id: 'personal_only',
    });

    const elsewhere = await callTool(
      'memory_get',
      { connection: 'memory.owner', id: 'personal_only' },
      { url: readOnly.server.url, token: 'llk_readonly_token_value', profile: 'readonly' },
    );

    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain('No memory entry');
  });
});
