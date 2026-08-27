import { describe, expect, test } from 'bun:test';
import { HARNESSES } from './harnesses.ts';
import { listRegistrations, mcpList, type McpListing } from './list.ts';

/**
 * `lanes link mcp list`, and its `--json`.
 *
 * The property under test is the one the flag exists for: both renderings
 * describe the same snapshot. A UI deciding between "add" and "re-add" reads the
 * JSON; a person reads the text; and a probe taken twice would let the two
 * disagree about a registration that changed in between.
 *
 * Nothing here stubs `Bun.which` or the harness binaries, so the assertions are
 * about shape and about agreement rather than about which harnesses happen to be
 * installed on the machine running the suite.
 */

/** Everything written to stdout while `body` runs. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  try {
    await body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  }

  return captured;
}

describe('the listing', () => {
  test('carries one entry per known harness, in registry order', async () => {
    const listing = await listRegistrations('lanes-link', 'user');

    expect(listing.harnesses.map((one) => one.id)).toEqual(HARNESSES.map((one) => one.id));
    expect(listing.name).toBe('lanes-link');
    expect(listing.scope).toBe('user');
  });

  test('a harness with no binary reports nothing about its documents', async () => {
    // With no binary there is nothing to register the documents against, and
    // reporting them would describe a setup that does not exist. The text
    // rendering already stops at "not installed"; the JSON has to agree.
    const listing = await listRegistrations('lanes-link', 'user');

    for (const harness of listing.harnesses) {
      if (harness.installed) continue;
      expect(harness.binary).toBeNull();
      expect(harness.registered).toBe(false);
      expect(harness.documents).toEqual([]);
    }
  });

  test('every document state is one the renderer knows how to draw', async () => {
    const listing = await listRegistrations('lanes-link', 'user');
    const known = ['current', 'stale', 'missing', 'unreadable'];

    for (const harness of listing.harnesses) {
      for (const document of harness.documents) {
        expect(known).toContain(document.state);
        expect(document.label.length).toBeGreaterThan(0);
        expect(document.path.length).toBeGreaterThan(0);
      }
    }
  });

  test('the name is what registrations are looked up under', async () => {
    // Not a cosmetic field: `exists()` asks each harness for *this* name, so a
    // listing under a different name is a different question with a different
    // answer.
    const listing = await listRegistrations('something-else', 'user');
    expect(listing.name).toBe('something-else');
  });
});

describe('--json', () => {
  test('prints parseable JSON and nothing else', async () => {
    const raw = await captureStdout(() => mcpList({ json: true }));

    const parsed = JSON.parse(raw) as McpListing;
    expect(parsed.name).toBe('lanes-link');
    expect(parsed.harnesses.map((one) => one.id)).toEqual(HARNESSES.map((one) => one.id));
  });

  test('agrees with the text rendering about what is registered', async () => {
    const raw = await captureStdout(() => mcpList({ json: true }));
    const text = await captureStdout(() => mcpList({ json: false }));
    const parsed = JSON.parse(raw) as McpListing;

    for (const harness of parsed.harnesses) {
      expect(text).toContain(harness.label);

      if (!harness.installed) {
        // The one line a missing harness gets.
        expect(text).toMatch(new RegExp(`${harness.label}\\s+.*not installed`));
        continue;
      }

      expect(text).toMatch(
        harness.registered
          ? new RegExp(`${harness.label}\\s+.*\\bregistered`)
          : new RegExp(`${harness.label}\\s+.*not registered`),
      );

      for (const document of harness.documents) {
        expect(text).toContain(document.label);
      }
    }
  });

  test('the scope reaches the payload, so a local-scope listing says so', async () => {
    const raw = await captureStdout(() => mcpList({ json: true, scope: 'local' }));
    expect((JSON.parse(raw) as McpListing).scope).toBe('local');
  });
});
