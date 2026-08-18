import { describe, expect, test } from 'bun:test';
import { allocatePort, startStdioHarness } from './harness.ts';

/**
 * The stdio surface, driven by a real MCP client over a linked transport pair.
 *
 * These assert the property that makes a second transport worth having at all:
 * that it is the *same* surface. A client spawning `lanes link mcp stdio` sees
 * the tools its policy permits, its calls are audited, and a call naming a tool
 * policy hid is refused and recorded — the last one being the guarantee the
 * pipe could most easily have dropped, since it has no headers to read.
 */

describe('the stdio surface', () => {
  test('advertises exactly what policy permits, with no token in sight', async () => {
    const harness = await startStdioHarness({
      profile: 'personal',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"\n  deny:\n    - "example.list_notes"`,
    });

    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name).sort();

      expect(names).toContain('example_echo');
      expect(names).toContain('example_get_note');
      // Denied capabilities are filtered out of discovery rather than refused
      // on call — the same rule the HTTP surface follows.
      expect(names).not.toContain('example_list_notes');
    } finally {
      await harness.stop();
    }
  });

  test('a permitted call runs and is audited', async () => {
    const harness = await startStdioHarness({
      profile: 'personal',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"`,
    });

    try {
      const result = await harness.client.callTool({
        name: 'example_echo',
        arguments: { profile: 'personal', connection: 'example.a', message: 'over a pipe' },
      });

      expect(JSON.stringify(result.content)).toContain('over a pipe');

      const [event] = await harness.audit.tail();
      expect(event).toMatchObject({
        capability: 'example.echo',
        principal: 'personal:owner',
        status: 'ok',
      });
    } finally {
      await harness.stop();
    }
  });

  test('a call naming a hidden capability is recorded as a refusal', async () => {
    const harness = await startStdioHarness({
      profile: 'denials',
      port: allocatePort(),
      policy: `  allow:\n    - "example.get_note"`,
    });

    try {
      // Not advertised, so the protocol layer answers this before dispatch
      // runs. Over HTTP the edge reads the 2026-07-28 headers to notice; over a
      // pipe there are no headers, and the transport wrapper is what keeps the
      // trace from disappearing.
      await harness.client
        .callTool({
          name: 'example_set_note',
          arguments: { profile: 'denials', connection: 'example.a', key: 'k', value: 'v' },
        })
        .catch(() => undefined);

      // The refusal is written just after the error goes out, so give the
      // append a turn to land rather than racing it.
      await Bun.sleep(50);

      const denied = await harness.audit.tail({ deniedOnly: true });
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        capability: 'example.set_note',
        principal: 'denials:owner',
        status: 'not_invoked',
      });
    } finally {
      await harness.stop();
    }
  });

  test('an advertised call is not mistaken for a refusal', async () => {
    const harness = await startStdioHarness({
      profile: 'allowed',
      port: allocatePort(),
      policy: `  allow:\n    - "example.*"`,
    });

    try {
      await harness.client.callTool({
        name: 'example_echo',
        arguments: { profile: 'allowed', connection: 'example.a', message: 'fine' },
      });

      await Bun.sleep(50);

      expect(await harness.audit.tail({ deniedOnly: true })).toHaveLength(0);
      expect(await harness.audit.tail()).toHaveLength(1);
    } finally {
      await harness.stop();
    }
  });

  test('every profile in the workspace is reachable through the one pipe', async () => {
    const harness = await startStdioHarness({
      profile: 'personal',
      port: allocatePort(),
      policy: `  allow:\n    - "example.echo"`,
      alsoServe: [{ profile: 'work', policy: `  allow:\n    - "example.echo"` }],
    });

    try {
      const { tools } = await harness.client.listTools();
      const echo = tools.find((tool) => tool.name === 'example_echo');
      const profiles = (
        echo?.inputSchema as { properties?: { profile?: { enum?: string[] } } } | undefined
      )?.properties?.profile?.enum;

      expect(profiles?.sort()).toEqual(['personal', 'work']);
    } finally {
      await harness.stop();
    }
  });
});
