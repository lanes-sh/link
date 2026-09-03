import { afterAll, describe, expect, test } from 'bun:test';
import { parseConfig } from '#profile';
import { type ProviderRegistry } from '#registry';
import { loadProfileSkills } from '#providers/skills/store.ts';
import { createSkillsProvider } from '#providers/owner.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import { allocatePort, rpc, startHarness } from './harness.ts';

/**
 * Authoring a skill over MCP, end to end — ADR-014.
 *
 * The reversal ADR-014 makes is only worth anything if the skill an agent
 * writes is *usable*: each skill is its own capability, so without the registry
 * catching up a write would succeed and the prompt would not exist until the
 * endpoint restarted. That is the property this file holds.
 *
 * It also holds the two things that keep the reversal safe — that authoring is
 * a separate grant, and that a profile without it can invoke skills and neither
 * write nor read one.
 */

const SEED = `---
description: Review a diff for correctness
arguments:
  - name: diff
    description: The unified diff
    required: true
---
Review this diff for correctness:

{{diff}}`;

const WRITTEN = `---
description: Draft a reply in the owner's voice
---
Draft a reply.`;

/**
 * A skills store, and the refresher an endpoint drives.
 *
 * The same shape `openRuntime` builds: rebuild the provider from the store and
 * swap it into the registry that is already serving. Written out here rather
 * than imported so this test exercises the `ProfileRuntime` contract itself.
 */
function skillsFixture(): { store: BlobStore; refresh: (registry: ProviderRegistry) => Promise<void> } {
  const store = createMemoryBlobStore();
  let fingerprint = '';

  const refresh = async (registry: ProviderRegistry): Promise<void> => {
    const next = (await store.list())
      .map((blob) => `${blob.key}:${blob.size}:${blob.modifiedAt.getTime()}`)
      .sort()
      .join('\n');
    if (next === fingerprint) return;
    fingerprint = next;

    registry.replace(
      createSkillsProvider({
        skills: await loadProfileSkills(store),
        store,
        onChange: () => refresh(registry),
      }),
    );
  };

  return { store, refresh };
}

function config(profile: string, port: number, policy: string) {
  return parseConfig(`
contract: 5
instance:
  profile: ${profile}
  port: ${port}
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
grants:
  - connection: lanes_skills.owner
${policy.split('\n').filter((line) => line.trim().length > 0).map((line) => `  ${line}`).join('\n')}
members: []
`).config;
}

const authorPort = allocatePort();
const invokePort = allocatePort();

const authorFixture = skillsFixture();
await authorFixture.store.put('review-diff.md', new TextEncoder().encode(SEED));

/** Everything granted, including authoring. */
const author = startHarness({
  profile: 'personal',
  port: authorPort,
  policy: '',
  providers: [
    createSkillsProvider({
      skills: await loadProfileSkills(authorFixture.store),
      store: authorFixture.store,
    }),
  ],
  config: config('personal', authorPort, `  allow:\n    - "lanes_skills.*"`),
  refreshSkills: authorFixture.refresh,
});

const invokeFixture = skillsFixture();
await invokeFixture.store.put('review-diff.md', new TextEncoder().encode(SEED));

/** Skills it can run, and no way to see or change what they say. */
const invokeOnly = startHarness({
  profile: 'readonly',
  port: invokePort,
  policy: '',
  token: 'llk_readonly_token_value',
  providers: [
    createSkillsProvider({
      skills: await loadProfileSkills(invokeFixture.store),
      store: invokeFixture.store,
    }),
  ],
  config: config(
    'readonly',
    invokePort,
    `  allow:\n    - "lanes_skills.*"\n  deny:\n    - "lanes_skills.manage.*"`,
  ),
  refreshSkills: invokeFixture.refresh,
});

afterAll(async () => {
  await author.stop();
  await invokeOnly.stop();
});

const url = (harness: typeof author) => harness.server.url;

async function promptNames(harness: typeof author, token?: string): Promise<string[]> {
  const listed = await rpc(url(harness), 'prompts/list', {}, token ? { token } : {});
  const result = listed.body['result'] as { prompts: Array<{ name: string }> };
  return result.prompts.map((prompt) => prompt.name).sort();
}

describe('a skill written over MCP is a prompt on the next call', () => {
  test('without a restart, and invocable', async () => {
    expect(await promptNames(author)).toEqual(['lanes_skills_review-diff']);

    const written = await rpc(url(author), 'tools/call', {
      name: 'lanes_skills_manage_write',
      arguments: { profile: 'personal', connection: 'lanes_skills.owner', name: 'draft-reply', text: WRITTEN },
    });
    expect(written.status).toBe(200);
    expect(JSON.stringify(written.body)).toContain('Stored skill');

    // The endpoint throttles its own polling, but a write made *through* MCP
    // refreshes directly — so the very next call sees it.
    expect(await promptNames(author)).toEqual(['lanes_skills_draft-reply', 'lanes_skills_review-diff']);

    const got = await rpc(url(author), 'prompts/get', {
      name: 'lanes_skills_draft-reply',
      arguments: { profile: 'personal', connection: 'lanes_skills.owner' },
    });
    expect(JSON.stringify(got.body)).toContain('Draft a reply.');
  });

  test('and the first invocation is audited as a call, not a refusal', async () => {
    // The endpoint memoised the wire names it advertises. Left stale, a
    // just-added skill would be recorded as a refusal on its first use even
    // though it succeeded.
    const events = await author.audit.tail({ capability: 'lanes_skills.draft-reply' });
    const denied = await author.audit.tail({
      capability: 'lanes_skills.draft-reply',
      deniedOnly: true,
    });

    expect(events.length).toBeGreaterThan(0);
    expect(denied).toEqual([]);
  });

  test('removing it takes the prompt away again', async () => {
    await rpc(url(author), 'tools/call', {
      name: 'lanes_skills_manage_remove',
      arguments: { profile: 'personal', connection: 'lanes_skills.owner', name: 'draft-reply' },
    });

    expect(await promptNames(author)).toEqual(['lanes_skills_review-diff']);
  });
});

describe('what the handshake advertises', () => {
  test('a profile holding skills declares prompts, and declares them unannounced', async () => {
    // The other half of ADR-032, and the half that is easy to lose: a skill
    // registers as a prompt, not a tool, so `prompts.listChanged` governs
    // whether a client re-reads its skills. It carries the same SDK default and
    // the same inability — there is no stream to announce on — so it has to
    // carry the same `false`. The tools-side assertion lives in `index.test.ts`;
    // this is the one profile in the suite that actually has a prompt.
    const response = await fetch(url(invokeOnly), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer llk_readonly_token_value',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'listChanged-test', version: '0.0.0' },
        },
      }),
    });

    const text = await response.text();
    const line = text.split('\n').find((candidate) => candidate.startsWith('data:'));
    const body = line === undefined ? text : line.slice('data:'.length).trim();
    const capabilities = (JSON.parse(body) as { result?: { capabilities?: Record<string, { listChanged?: boolean }> } })
      .result?.capabilities;

    expect(capabilities?.['prompts']?.listChanged).toBe(false);
  });
});

describe('authoring is a separate grant', () => {
  const token = 'llk_readonly_token_value';

  test('an invoke-only profile is offered no management tool at all', async () => {
    // An empty list, and deliberately not `Method not found`.
    //
    // It used to be the latter: nothing registered a tool for this principal,
    // so the SDK never installed the handler. Declaring the `tools` capability
    // up front — which is what stops the endpoint promising a `list_changed`
    // notification it cannot send — installs it unconditionally, and the answer
    // becomes the true one. The difference is the same difference that fix is
    // about: "this server has no tools right now" invites a client to ask
    // again, and "this server does not do tools" tells it never to.
    //
    // What the test is actually about is unchanged. Policy-filtered discovery
    // means the four `lanes_skills.manage.*` capabilities are not withheld at call
    // time — they were never advertised.
    const listed = await rpc(url(invokeOnly), 'tools/list', {}, { token });
    const result = listed.body['result'] as { tools?: unknown[] } | undefined;

    expect(listed.body['error']).toBeUndefined();
    expect(result?.tools).toEqual([]);
  });

  test('it can still invoke the skills it has', async () => {
    expect(await promptNames(invokeOnly, token)).toEqual(['lanes_skills_review-diff']);

    const got = await rpc(
      url(invokeOnly),
      'prompts/get',
      {
        name: 'lanes_skills_review-diff',
        arguments: { profile: 'readonly', connection: 'lanes_skills.owner', diff: '--- a\n+++ b' },
      },
      { token },
    );
    expect(JSON.stringify(got.body)).toContain('--- a');
  });

  test('and cannot read what one says — the half of ADR-012 §1 that stands', async () => {
    // Reading a body is in the author bundle, not the read one: an agent that
    // could read every skill could choose its own instructions from the
    // catalogue, which is exactly what the prompt primitive withholds.
    const denied = await rpc(
      url(invokeOnly),
      'tools/call',
      {
        name: 'lanes_skills_manage_get',
        arguments: { profile: 'readonly', connection: 'lanes_skills.owner', name: 'review-diff' },
      },
      { token },
    );

    expect(JSON.stringify(denied.body)).not.toContain('Review this diff');
  });

  test('a denied write is recorded under its real capability id', async () => {
    await rpc(
      url(invokeOnly),
      'tools/call',
      {
        name: 'lanes_skills_manage_write',
        arguments: { profile: 'readonly', connection: 'lanes_skills.owner', name: 'x', text: WRITTEN },
      },
      { token },
    );

    const refusals = await invokeOnly.audit.tail({
      capability: 'lanes_skills.manage.write',
      deniedOnly: true,
    });

    expect(refusals.length).toBeGreaterThan(0);
    expect(await invokeFixture.store.has('x.md')).toBe(false);
  });
});
