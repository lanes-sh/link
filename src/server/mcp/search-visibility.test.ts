import { describe, expect, test } from 'bun:test';
import { memberPrincipal, ownerPrincipal } from '#auth';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerSearchSurface } from './search.ts';
import type { ProfileRuntime } from './visibility.ts';

/**
 * Which profiles the two surface tools admit to knowing about.
 *
 * `lanes_tools_search` and `lanes_tools_call` are registered outside the loop
 * over what policy decided (ADR-075), which is what made them the last place a
 * profile name leaked: `mergeCapabilities` filtered what it returned, and these
 * two read the profile map sitting beside it. A member of one profile was
 * handed a schema naming every profile the endpoint served.
 *
 * Dispatch refused the call either way, so this was disclosure rather than
 * access. It is still the thing ADR-060 says does not happen — "a member does
 * not fail to call a profile they are not on, they never see it".
 */

function profile(): ProfileRuntime {
  return {
    config: { description: null, grants: [], members: [] },
    registry: { capabilities: () => [] },
    policy: { byConnection: new Map() },
  } as unknown as ProfileRuntime;
}

const PROFILES = new Map([
  ['personal', profile()],
  ['work', profile()],
  ['sandbox', profile()],
]);

/** Records what each tool was registered with, which is all this needs. */
function capturing(): { server: McpServer; enums: () => string[][] } {
  const schemas: string[][] = [];

  const server = {
    registerTool: (_name: string, config: { inputSchema?: Record<string, unknown> }) => {
      const shape = config.inputSchema ?? {};
      const field = shape['profile'] as { def?: { entries?: Record<string, string> } } | undefined;
      // Zod keeps an enum's members on the schema; both tools declare `profile`
      // as one, optional on search and required on call.
      const inner = (field as { def?: { innerType?: unknown } })?.def?.innerType ?? field;
      const entries = (inner as { def?: { entries?: Record<string, string> } })?.def?.entries;
      if (entries) schemas.push(Object.keys(entries));
    },
    registerResource: () => {},
    registerPrompt: () => {},
  } as unknown as McpServer;

  return { server, enums: () => schemas };
}

describe('the profile enum on the surface tools', () => {
  test('names only the profiles this caller reaches', () => {
    const { server, enums } = capturing();

    registerSearchSurface(server, {
      profiles: PROFILES,
      principal: memberPrincipal('lanes:HER', 'personal', ['personal']),
    } as never);

    expect(enums()).not.toEqual([]);
    for (const listed of enums()) expect(listed).toEqual(['personal']);
  });

  test('a member of nothing is offered nothing', () => {
    const { server, enums } = capturing();

    registerSearchSurface(server, {
      profiles: PROFILES,
      principal: memberPrincipal('lanes:STRANGER', 'personal', []),
    } as never);

    for (const listed of enums()) expect(listed).toEqual([]);
  });

  test('the owner still sees the whole workspace, because that is what it is', () => {
    const { server, enums } = capturing();

    registerSearchSurface(server, {
      profiles: PROFILES,
      principal: ownerPrincipal('personal'),
    } as never);

    expect(enums()).not.toEqual([]);
    for (const listed of enums()) {
      expect(listed.sort()).toEqual(['personal', 'sandbox', 'work']);
    }
  });
});
