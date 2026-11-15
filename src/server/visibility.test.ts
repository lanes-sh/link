import { describe, expect, test } from 'bun:test';
import { allocatePort, rpc, startHarness } from './harness.ts';

/**
 * What one caller is told this endpoint serves.
 *
 * `mergeCapabilities` filters on `mayReach`, and three separate places read the
 * profile map sitting beside it. ADR-079 found the first — the `profile` enum on
 * `lanes_tools_search` and `lanes_tools_call`, which register outside the loop
 * over what policy decided and so built their enum from the whole map. It did
 * not find the other two, and both are asserted here:
 *
 *   - `buildMcpServer`'s server `title`, which names its profiles and is served
 *     to every caller on `initialize`.
 *   - `accountsByProfile`, which feeds the `Reachable from here` box at the top
 *     of every search answer and the structured `reachable` field beside it.
 *
 * The rule each one has to satisfy is ADR-060's: a member does not merely fail
 * to call a profile they are not on, they never learn it exists. So every test
 * here has an owner counterpart, because the filter has to be the caller's
 * membership and not a blanket narrowing to the primary — which is the way a
 * filter like this has already been got wrong once (`index.test.ts`, `/health`).
 */

const POLICY = 'allow: ["example.*"]';

/** Two profiles served, and a token whose subject reaches only what is named. */
function delegated(reaches?: readonly string[]) {
  return startHarness({
    profile: 'personal',
    port: allocatePort(),
    policy: POLICY,
    alsoServe: [{ profile: 'work', policy: POLICY }],
    ...(reaches === undefined ? {} : { reaches }),
  });
}

async function title(url: string): Promise<string | undefined> {
  const response = await rpc(url, 'server/discover', {});
  const result = response.body['result'] as {
    _meta?: Record<string, { title?: string }>;
  };
  return result._meta?.['io.modelcontextprotocol/serverInfo']?.title;
}

async function search(
  url: string,
): Promise<{ text: string; reachable: { profile: string }[] }> {
  const response = await rpc(url, 'tools/call', {
    name: 'lanes_tools_search',
    arguments: { query: 'note' },
  });
  const result = response.body['result'] as {
    content?: { text?: string }[];
    structuredContent?: { reachable?: { profile: string }[] };
  };

  return {
    text: (result?.content ?? []).map((block) => block.text ?? '').join('\n'),
    reachable: result?.structuredContent?.reachable ?? [],
  };
}

describe('the endpoint titles itself with the caller\'s profiles', () => {
  test('a member of one profile is not told the other one exists', async () => {
    // `title` was built from `[...options.profiles.keys()]` unfiltered, so this
    // read `Lanes Link — personal, work` for a caller no member list names on
    // `work`. The same leak ADR-079 closed in the enum, in the one field beside
    // it that nobody had read.
    const harness = delegated(['personal']);

    try {
      expect(await title(harness.server.url)).toBe('Lanes Link — personal');
    } finally {
      await harness.stop();
    }
  });

  test('and names every profile to a caller who is a member of all of them', async () => {
    // The contrast is what makes the test above mean something: the filter is
    // the caller's membership, not a narrowing to the primary.
    const harness = delegated();

    try {
      expect(await title(harness.server.url)).toBe('Lanes Link — personal, work');
    } finally {
      await harness.stop();
    }
  });
});

describe('a search answer names only the accounts the caller can reach', () => {
  test('a profile they are not on is absent from the prose and from the field', async () => {
    // `accountsByProfile` iterated every profile served. `render.ts` prints it
    // as "pass one of these as `profile`", and `search-index.ts` repeats it in
    // the declared `reachable` output field — so a delegated member read the
    // name of a profile they cannot reach, and its accounts with it.
    const harness = delegated(['personal']);

    try {
      const answer = await search(harness.server.url);

      expect(answer.text).not.toContain('work');
      expect(answer.reachable.map((row) => row.profile)).toEqual(['personal']);
    } finally {
      await harness.stop();
    }
  });

  test('and names both to a caller who is a member of both', async () => {
    const harness = delegated();

    try {
      const answer = await search(harness.server.url);

      expect(answer.reachable.map((row) => row.profile).sort()).toEqual(['personal', 'work']);
    } finally {
      await harness.stop();
    }
  });

  test('a member of nothing is told about no accounts either', async () => {
    // ADR-079's rule for a caller who reaches none of the profiles that exist:
    // a row carries an account name, and they have proved only that they
    // signed in.
    const harness = delegated([]);

    try {
      const answer = await search(harness.server.url);

      expect(answer.reachable).toEqual([]);
      expect(answer.text).not.toContain('personal');
      expect(answer.text).not.toContain('work');
    } finally {
      await harness.stop();
    }
  });
});
