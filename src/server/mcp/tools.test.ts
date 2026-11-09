import { describe, expect, test } from 'bun:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { ownerPrincipal } from '#auth';
import type { ToolResult } from '#connectivity';
import { parseConfig } from '#profile';
import { toPolicyDocument } from '#registry';
import { buildMcpServer } from './build.ts';
import { oneProfile, type BuildServerOptions, type ProfileRuntime } from './visibility.ts';

/**
 * A discovered tool's answer, as this endpoint hands it on.
 *
 * Where an upstream declares an output schema, this endpoint advertises it as
 * its own (#202), and the specification is plain about what that costs: a
 * successful result must carry `structuredContent` that fits it. The SDK checks
 * that on the way out. With the data dropped, every successful call to such a
 * tool came back as "Output validation error: … has an output schema but no
 * structured content was provided".
 *
 * The registry and the dispatcher are faked, as in `unauthorized.test.ts`: what
 * is under test is what the tool handler does with a result, and a real
 * registry would need a workspace, a credential and an upstream to produce one.
 */

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, open: { type: 'boolean' } },
  required: ['id'],
};

/** An endpoint whose one vendor tool declares `OUTPUT_SCHEMA` and answers `result`. */
function endpointAnswering(result: ToolResult) {
  const { config } = parseConfig(`
contract: 5
instance:
  profile: personal
  port: 7300
grants:
  - connection: vendor.main
    allow: ["vendor.*"]
    deny: []
members: []
`);

  const runtime = {
    config,
    registry: {
      capabilities: () => [
        {
          id: 'vendor.get_thing',
          capability: undefined,
          discovered: {
            name: 'get_thing',
            description: 'Gets a thing.',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: OUTPUT_SCHEMA,
          },
        },
      ],
      expandBundle: () => [],
      manifest: () => undefined,
      get: () => undefined,
    },
    policy: toPolicyDocument(config),
    dispatcher: { invoke: async () => ({ ok: true, result }) },
  } as unknown as ProfileRuntime;

  const options = {
    profiles: oneProfile('personal', runtime),
    principal: ownerPrincipal('personal'),
  } as unknown as BuildServerOptions;

  return createMcpHandler(() => buildMcpServer(options));
}

/** One `tools/call` in the 2026-07-28 shape, as `harness.ts`'s `rpc` sends it. */
async function call(
  endpoint: ReturnType<typeof endpointAnswering>,
): Promise<{ isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }> {
  const params = { name: 'vendor_get_thing', arguments: { profile: 'personal', connection: 'vendor.main' } };

  const response = await endpoint.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': params.name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'lanes-link-test', version: '0.0.0' },
          },
        },
      }),
    }),
  );

  return ((await response.json()) as { result: never }).result;
}

describe('a discovered tool that declares an output schema', () => {
  test('hands its structured content on, so a successful call succeeds', async () => {
    const result = await call(
      endpointAnswering({
        content: [{ type: 'text', text: '{"id":"t1","open":true}' }],
        structuredContent: { id: 't1', open: true },
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: 't1', open: true });
    expect(result.content?.[0]?.text).toBe('{"id":"t1","open":true}');
  });

  test('an error carries no structured content, and stays the vendor\'s error', async () => {
    // The specification asks for data that fits only on success, and the SDK
    // checks it only then — so a refusal passes through as the vendor said it.
    const result = await call(
      endpointAnswering({ content: [{ type: 'text', text: 'No such thing.' }], isError: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe('No such thing.');
  });
});
