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

async function callTyped(
  url: string,
  profile: string,
): Promise<{ text: string; isError: boolean }> {
  const response = await rpc(url, 'tools/call', {
    name: 'example_echo',
    arguments: { message: 'x', profile, connection: 'example.a' },
  });
  const result = response.body['result'] as
    | { content?: { text?: string }[]; isError?: boolean }
    | undefined;

  return {
    text: (result?.content ?? []).map((block) => block.text ?? '').join('\n'),
    isError: result?.isError === true,
  };
}

async function callGateway(
  url: string,
  profile: string,
): Promise<{ text: string; isError: boolean }> {
  const response = await rpc(url, 'tools/call', {
    name: 'lanes_tools_call',
    arguments: {
      capability: 'example.echo',
      profile,
      connection: 'example.a',
      arguments: { message: 'x' },
    },
  });
  const result = response.body['result'] as
    | { content?: { text?: string }[]; isError?: boolean }
    | undefined;

  return {
    text: (result?.content ?? []).map((block) => block.text ?? '').join('\n'),
    isError: result?.isError === true,
  };
}

async function listTools(url: string): Promise<
  { name: string; inputSchema: { properties?: Record<string, Record<string, unknown>> } }[]
> {
  const response = await rpc(url, 'tools/list', {});
  return (
    (response.body['result'] as {
      tools?: { name: string; inputSchema: { properties?: Record<string, Record<string, unknown>> } }[];
    })?.tools ?? []
  );
}

describe('the refusal does not say which it was', () => {
  test('a profile the caller is not on is refused exactly as an unknown one is', async () => {
    // The property ADR-060 states — a member "never sees it exists" — used to be
    // held by the schema: the enum omitted the name, so the call was refused
    // before it was sent, or by zod if it was sent anyway. With `profile` a
    // plain string the call reaches the handler, and both names land in the one
    // branch for two different reasons: `work` is served, so `options.profiles`
    // has it and `entry.reachable` does not; `nowhere` is in neither.
    //
    // So the sentence has to be the same sentence. If it ever stops being, the
    // leak has moved out of the enum and into the error message, which is the
    // one thing this change must not do (ADR-079, and `/data`'s matching 404).
    const harness = delegated(['personal']);

    try {
      const absent = await callTyped(harness.server.url, 'nowhere');
      const refused = await callTyped(harness.server.url, 'work');

      expect(absent.isError).toBe(true);
      expect(refused.isError).toBe(true);
      expect(refused.text.replace('work', 'X')).toBe(absent.text.replace('nowhere', 'X'));

      // And what it does say is the caller's own list, which they already had.
      expect(refused.text).toContain('Available: personal');
      expect(refused.text).not.toContain('work,');
    } finally {
      await harness.stop();
    }
  });

  test('and the same holds through lanes_tools_call', async () => {
    // Its own refusal, on its own branch (`search.ts`), reached under
    // `surface: crunched` by callers who have no typed tool at all.
    const harness = delegated(['personal']);

    try {
      const absent = await callGateway(harness.server.url, 'nowhere');
      const refused = await callGateway(harness.server.url, 'work');

      expect(absent.isError).toBe(true);
      expect(refused.isError).toBe(true);
      expect(refused.text.replace('work', 'X')).toBe(absent.text.replace('nowhere', 'X'));
    } finally {
      await harness.stop();
    }
  });

  test('the profile it does name still works, so this is a filter and not an outage', async () => {
    const harness = delegated(['personal']);

    try {
      expect((await callTyped(harness.server.url, 'personal')).isError).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  test('a connection belonging to another profile is refused by this endpoint, not the SDK', async () => {
    // This branch was unreachable for a typed tool until ADR-082: the enum was
    // exactly `[...entry.reachable.keys()]`, so nothing that validated could
    // miss `reachable`. It is load-bearing now, so it is asserted now.
    const harness = delegated();

    try {
      const response = await rpc(harness.server.url, 'tools/call', {
        name: 'example_echo',
        arguments: { message: 'x', profile: 'personal', connection: 'example.nonexistent' },
      });
      const result = response.body['result'] as { content?: { text?: string }[]; isError?: boolean };
      const text = (result?.content ?? []).map((block) => block.text ?? '').join('\n');

      expect(result?.isError).toBe(true);
      expect(text).toContain('is not part of profile "personal"');
    } finally {
      await harness.stop();
    }
  });
});

describe('the injected arguments are strings', () => {
  test('profile carries a description and no enum', async () => {
    // The direct replacement for what `search-visibility.test.ts` pinned. It
    // read the members out of a zod enum, so against a `z.string()` it would
    // have passed vacuously rather than failed.
    const harness = delegated();

    try {
      const echo = (await listTools(harness.server.url)).find((t) => t.name === 'example_echo');
      const profile = echo?.inputSchema.properties?.['profile'];

      expect(profile?.['type']).toBe('string');
      expect(profile?.['enum']).toBeUndefined();
      expect(String(profile?.['description'])).toContain('personal');
    } finally {
      await harness.stop();
    }
  });

  test('a member of nothing is no longer served a property nothing satisfies', async () => {
    // `z.enum([])` published as `{"not":{}}` — a property no value can satisfy,
    // carrying a description inviting its use, which a strict client-side
    // validator can reject outright. A member of nothing still reaches nothing;
    // they are now told so by a refusal rather than by an unsatisfiable schema.
    const harness = delegated([]);

    try {
      const search = (await listTools(harness.server.url)).find(
        (t) => t.name === 'lanes_tools_search',
      );
      const profile = search?.inputSchema.properties?.['profile'];

      expect(profile?.['not']).toBeUndefined();
      expect(profile?.['type']).toBe('string');
    } finally {
      await harness.stop();
    }
  });
});
