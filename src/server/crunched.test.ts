import { afterAll, describe, expect, test } from 'bun:test';
import { parseConfig } from '#profile';
import { createSkillsProvider, memoryProvider } from '#providers/owner.ts';
import { allocatePort, rpc, startHarness } from './harness.ts';
import { SURFACE_TOOL_NAMES } from './mcp/index.ts';

/**
 * `surface: crunched`, against a real endpoint.
 *
 * The claim is narrow and the whole design rests on it: **the advertised list
 * shrinks and the reachable set does not**. So the assertions come in pairs —
 * what left `tools/list`, and the same capability still answering through
 * `lanes_tools_call`, with the refusals a typed tool would have made still
 * refusing.
 *
 * The control profile is the same wiring under `full`. Where a test asserts an
 * absence it asserts the presence beside it, because "no tools advertised"
 * would pass every absence in this file while meaning the endpoint is broken.
 */

const SKILL = {
  name: 'review-diff',
  description: 'Review a diff for correctness',
  arguments: [{ name: 'diff', description: 'The unified diff', required: true }],
  body: 'Review this diff:\n\n{{diff}}',
  path: '/w/skills/review-diff.md',
};

/**
 * One profile reaching a third-party provider and an owner-layer one.
 *
 * Both halves are needed: `example` is what a crunched surface stops
 * advertising, and `lanes_memory` is what it keeps. A fixture with only one of
 * them cannot tell "the owner layer survived" from "nothing was filtered".
 */
function config(profile: string, port: number, surface: 'full' | 'crunched') {
  return parseConfig(`
contract: 5
instance:
  profile: ${profile}
  port: ${port}
surface: ${surface}
limits:
  requests_per_minute: 1000
  upstream_calls_per_minute: 1000
grants:
  - connection: example.a
    allow: ["example.*"]
    deny: ["example.list_notes"]
  - connection: lanes_memory.owner
    allow: ["lanes_memory.*"]
  - connection: lanes_skills.owner
    allow: ["lanes_skills.*"]
members: []
`).config;
}

const providers = () => [memoryProvider, createSkillsProvider({ skills: [SKILL] })];

const crunchedPort = allocatePort();
const fullPort = allocatePort();

const crunched = startHarness({
  profile: 'personal',
  port: crunchedPort,
  policy: '',
  providers: providers(),
  config: config('personal', crunchedPort, 'crunched'),
});

/** The same wiring, unchanged — every assertion below is read against this. */
const full = startHarness({
  profile: 'personal',
  port: fullPort,
  policy: '',
  providers: providers(),
  config: config('personal', fullPort, 'full'),
});

afterAll(async () => {
  await Promise.all([crunched.stop(), full.stop()]);
});

async function names(url: string): Promise<string[]> {
  const response = await rpc(url, 'tools/list', {});
  const tools = (response.body['result'] as { tools?: { name: string }[] })?.tools ?? [];
  return tools.map((tool) => tool.name);
}

async function callGateway(
  url: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const response = await rpc(url, 'tools/call', { name: 'lanes_tools_call', arguments: args });
  const result = response.body['result'] as
    | { content?: { text?: string }[]; isError?: boolean }
    | undefined;
  return { text: result?.content?.[0]?.text ?? '', isError: result?.isError === true };
}

describe('a crunched surface', () => {
  test('advertises the owner layer and the stable-name pair, and nothing else', async () => {
    const advertised = await names(crunched.server.url);

    for (const name of SURFACE_TOOL_NAMES) expect(advertised).toContain(name);
    expect(advertised).toContain('lanes_memory_write');

    // The third-party provider is the thing that left. Asserted against the
    // control below, so this cannot pass by advertising nothing at all.
    expect(advertised).not.toContain('example_echo');
    expect(await names(full.server.url)).toContain('example_echo');
  });

  test('full is what it always was', async () => {
    const advertised = await names(full.server.url);

    expect(advertised).toContain('example_echo');
    expect(advertised).toContain('lanes_memory_write');
    for (const name of SURFACE_TOOL_NAMES) expect(advertised).toContain(name);
  });

  test('a de-advertised capability still runs, and answers the same', async () => {
    const args = {
      capability: 'example.echo',
      profile: 'personal',
      connection: 'example.a',
      arguments: { message: 'still here' },
    };

    const viaGateway = await callGateway(crunched.server.url, args);

    expect(viaGateway.isError).toBe(false);
    expect(viaGateway.text).toContain('still here');

    // The same call on the control, where the typed tool exists, to show the
    // gateway is not a second implementation that happens to agree.
    expect(await callGateway(full.server.url, args)).toEqual(viaGateway);
  });

  test('search finds what is no longer advertised, with its schema', async () => {
    const response = await rpc(crunched.server.url, 'tools/call', {
      name: 'lanes_tools_search',
      arguments: { query: 'example.echo' },
    });
    const text =
      (response.body['result'] as { content?: { text?: string }[] })?.content?.[0]?.text ?? '';

    expect(text).toContain('example.echo');
    // Without the arguments a model cannot compose the call, which would make
    // the whole mode unusable rather than merely smaller.
    expect(text).toContain('arguments');
    expect(text).toContain('message');

    // And it must not tell the model to prefer a typed tool that this mode
    // never advertises — the reason a tool is absent is the part acted on.
    expect(text).toContain('advertises a small surface on purpose');
    expect(text).not.toContain('Prefer the named tool');
  });

  test('a denied capability is no more reachable than before', async () => {
    // The load-bearing one. `crunched` removes capabilities from the *list*; if
    // it removed them from the merged set instead, this would start passing for
    // the wrong reason, so the assertion is that the refusal is unchanged.
    const outcome = await callGateway(crunched.server.url, {
      capability: 'example.list_notes',
      profile: 'personal',
      connection: 'example.a',
      arguments: {},
    });

    expect(outcome.isError).toBe(true);
    expect(await names(crunched.server.url)).not.toContain('example_list_notes');
  });

  test('the count the endpoint reports is the count on the wire', async () => {
    // ADR-032's whole reason for existing: an operator compares the number
    // `/reload` and `connect` print against what their client shows. A mode that
    // advertised less than it counted would make that comparison a false alarm,
    // and it is the drift `advertisedTools` is shared to prevent.
    for (const harness of [crunched, full]) {
      const response = await fetch(harness.server.url.replace('/mcp', '/reload'), {
        method: 'POST',
        headers: { authorization: `Bearer ${harness.token}` },
      });
      const body = (await response.json()) as { tools?: number };

      expect(body.tools).toBe((await names(harness.server.url)).length);
    }
  });

  test('prompts are untouched — a skill is not a tool', async () => {
    const response = await rpc(crunched.server.url, 'prompts/list', {});
    const prompts = (response.body['result'] as { prompts?: { name: string }[] })?.prompts ?? [];

    expect(prompts.map((prompt) => prompt.name)).toContain('lanes_skills_review-diff');
  });

  test('neither half of the pair sends the instance back to its config on a hit', async () => {
    // The inverse of the stale-instance fix, and it has to hold for both halves.
    // `knows()` asks the gateway about the capability it names and the search
    // about whether anything matches its query; if either answered "unknown" for
    // something this instance can perfectly well reach, every call under this
    // mode would provoke a reload — the whole workspace re-opened, per call, to
    // learn what it already knew.
    const epoch = async () => {
      const response = await fetch(crunched.server.url.replace('/mcp', '/reload'), {
        method: 'POST',
        headers: { authorization: `Bearer ${crunched.token}` },
      });
      return ((await response.json()) as { epoch?: number }).epoch;
    };

    const before = await epoch();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await callGateway(crunched.server.url, {
        capability: 'example.echo',
        profile: 'personal',
        connection: 'example.a',
        arguments: { message: 'again' },
      });
      await rpc(crunched.server.url, 'tools/call', {
        name: SURFACE_TOOL_NAMES[0]!,
        arguments: { query: 'echo a message' },
      });
    }

    // One epoch for the explicit reload above, one for the one below, and none
    // in between — the calls did not add any.
    expect(await epoch()).toBe((before ?? 0) + 1);
  });

  test('a search that matches nothing is answered, not refused', async () => {
    // The probe fires here — nothing reachable matches — and this asserts what
    // happens *after* it: one reload finds the config unchanged, and the search
    // still answers with the same sentence it always did. The self-heal is a
    // retry of the question, never a different answer to it.
    const response = await rpc(crunched.server.url, 'tools/call', {
      name: SURFACE_TOOL_NAMES[0]!,
      arguments: { query: 'quantumfoobarbaz' },
    });
    const result = response.body['result'] as
      | { content?: { text?: string }[]; isError?: boolean }
      | undefined;

    expect(result?.isError).toBeFalsy();
    expect(result?.content?.[0]?.text ?? '').toContain('Nothing reachable matches');
  });

  test('a call through the gateway is not recorded as a refusal', async () => {
    await callGateway(crunched.server.url, {
      capability: 'example.echo',
      profile: 'personal',
      connection: 'example.a',
      arguments: { message: 'audited' },
    });

    await Bun.sleep(50);

    // De-advertising a tool must not make its own successful invocation look
    // like an agent reaching for something it was never offered.
    expect(await crunched.audit.tail({ deniedOnly: true })).toHaveLength(0);
  });
});
