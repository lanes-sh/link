import { afterAll, describe, expect, test } from 'bun:test';
import { parseConfig } from '#profile';
import { assetsProvider } from '#providers/owner.ts';
import { allocatePort, rpc, startHarness } from '../harness.ts';
import { annotationsFor } from './annotations.ts';

/**
 * What a client is told about how these tools behave.
 *
 * The defect this pins was visible in a client and invisible here: a plugin
 * inspector rendered `lanes_assets_get` as PUBLIC WRITE, OPEN WORLD and
 * DESTRUCTIVE. It is none of them — `src/providers/assets/provider.ts` puts
 * `get` in the `read` bundle, described as "List and read stored files", and
 * has since it was written. The client was not guessing wrongly; it was
 * applying the cautious default the specification mandates for a tool that
 * ships no annotations, and this endpoint shipped none.
 *
 * What that cost is not abstract. A client's "allow low-risk actions" setting
 * finds nothing low-risk on an endpoint where every tool is marked destructive,
 * so reading a file the owner stored themselves takes a human click — a round
 * trip through a person, on every call.
 */

const port = allocatePort();

/** One owner-layer provider whose bundles split reading from writing. */
const endpoint = startHarness({
  profile: 'personal',
  port,
  policy: '',
  providers: [assetsProvider],
  config: parseConfig(`
contract: 5
instance:
  profile: personal
  port: ${port}
grants:
  - connection: lanes_assets.owner
    allow: ["lanes_assets.*"]
members: []
`).config,
});

afterAll(async () => {
  await endpoint.stop();
});

type Advertised = {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

async function advertised(): Promise<Advertised[]> {
  const response = await rpc(endpoint.server.url, 'tools/list', {});
  expect(response.status).toBe(200);
  return ((response.body['result'] ?? {}) as { tools?: Advertised[] }).tools ?? [];
}

describe('the hints a tool carries', () => {
  /**
   * All four, on every tool. The specification's guidance is to set them
   * explicitly rather than lean on defaults, and the defaults are the whole
   * problem: every one of them is the most cautious reading.
   */
  test('every advertised tool declares all four', async () => {
    const missing = (await advertised())
      .filter(
        ({ annotations }) =>
          annotations?.readOnlyHint === undefined ||
          annotations.destructiveHint === undefined ||
          annotations.idempotentHint === undefined ||
          annotations.openWorldHint === undefined,
      )
      .map(({ name }) => name);

    expect(missing).toEqual([]);
  });

  /**
   * The case from the client, asserted by name because it is the one that
   * happened and a percentage would hide it coming back.
   */
  test('reading a stored file is advertised as a read', async () => {
    const tool = (await advertised()).find(({ name }) => name === 'lanes_assets_get');

    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });

  /** And storing one is not, so the hint distinguishes rather than flatters. */
  test('storing a file is not', async () => {
    const tool = (await advertised()).find(({ name }) => name === 'lanes_assets_store');

    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  /**
   * The search reads a catalogue this endpoint already holds. Nothing leaves
   * the process and asking twice gives the same answer, so it is the one tool
   * here a client can stop asking permission for — which is most of what makes
   * a search cheap enough to be the first thing an agent does.
   */
  test('the search is safe to run without asking', async () => {
    const tool = (await advertised()).find(({ name }) => name === 'lanes_tools_search');

    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  /**
   * The gateway cannot say, because what it does depends on the capability
   * named in the call. A hint is a property of a tool and this tool is every
   * tool, so the only honest posture is the cautious one — and that is a cost
   * of routing provider calls through one name, not an oversight.
   */
  test('the gateway declines to claim anything', async () => {
    const tool = (await advertised()).find(({ name }) => name === 'lanes_tools_call');

    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });
});

describe('what the hints are derived from', () => {
  /**
   * Never guessed from the name, though the ranking guesses from it freely for
   * ordering. Ordering may be wrong and cost a turn; a hint about whether a
   * call is safe may not, because a client is entitled to relax a confirmation
   * on the strength of it.
   */
  test('the owner layer is a closed domain and a provider is not', () => {
    expect(annotationsFor('lanes_memory.search', true).openWorldHint).toBe(false);
    expect(annotationsFor('gmail.users.messages.list', true).openWorldHint).toBe(true);
  });

  test('a read is idempotent and a write is not claimed to be', () => {
    expect(annotationsFor('lanes_tasks.list', true).idempotentHint).toBe(true);
    expect(annotationsFor('lanes_tasks.add', false).idempotentHint).toBe(false);
  });
});
