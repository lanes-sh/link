import { describe, expect, test } from 'bun:test';
import { type Capability, type ProviderContext } from '#connectivity';
import type { IdentityEntry } from '#profile';
import { createIdentityProvider } from './provider.ts';

/**
 * The read-only identity surface.
 *
 * Two properties carry the design and both are structural:
 *
 * - Nothing here writes. This block is configuration, and an agent able to edit
 *   it could edit the one fact that stops it signing as the wrong person — so
 *   the capability list holding exactly one read is the claim, and it is
 *   asserted rather than left to review.
 * - It says enough to be *acted on*. A list of names with no ranking and no
 *   notes is a list a model picks from at random, which is the behaviour this
 *   whole feature exists to replace. So the rendering is tested for the parts
 *   that make a choice possible, not for wording.
 */

function capabilities(entries: readonly IdentityEntry[]): Capability[] {
  return [...createIdentityProvider({ profile: 'personal', entries }).capabilities];
}

/** Nothing on the context is read by this handler; it is required, not used. */
const context = { connection: { key: 'identity.main', id: 'main', provider: 'identity' } } as
  unknown as ProviderContext;

async function textOf(entries: readonly IdentityEntry[]): Promise<string> {
  const found = capabilities(entries).find((capability) => capability.name === 'list');
  if (!found) throw new Error('no capability "list"');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (found as any).handler({}, context)) as { content: { text: string }[] };
  return result.content.map((part) => part.text).join('\n');
}

const DECLARED: readonly IdentityEntry[] = [
  { kind: 'name', value: 'Ada', note: 'use for open-source work' },
  { kind: 'email', value: 'ada@example.com' },
  { kind: 'name', value: 'A. Lovelace', note: 'use on anything published' },
  { kind: 'github', value: 'octocat' },
];

describe('the surface is read-only', () => {
  test('offers exactly one capability, and it is a read', () => {
    const offered = capabilities([]);

    expect(offered.map((capability) => capability.name)).toEqual(['list']);
    expect(offered[0]?.kind).toBe('tool');
  });

  test('offers no write bundle', () => {
    const bundles = createIdentityProvider({ profile: 'personal' }).manifest.bundles ?? [];

    expect(bundles.map((bundle) => bundle.name)).toEqual(['read']);
    // A scope list would mean a third party had to consent to something. This
    // reads a local file.
    expect(bundles[0]?.oauth_scopes).toEqual([]);
  });
});

describe('what it reports', () => {
  test('names the profile it is reporting for', async () => {
    // The handler cannot learn this — the routing arguments are stripped before
    // dispatch — so it is stamped at construction, and a report that did not
    // say which profile it described would be unusable on an endpoint serving
    // more than one.
    expect(await textOf(DECLARED)).toContain('profile "personal"');
  });

  test('keeps each entry with its note', async () => {
    const text = await textOf(DECLARED);

    expect(text).toContain('use for open-source work');
    expect(text).toContain('use on anything published');
    expect(text).toContain('ada@example.com');
    expect(text).toContain('octocat');
  });

  test('groups the kinds, so a name cannot be read as an address', async () => {
    const lines = (await textOf(DECLARED)).split('\n').filter((line) => line.startsWith('  '));
    const kinds = lines.map((line) => line.trim().split(/\s+/)[0]);

    // Declaration order interleaves the two names with an email between them.
    // Adjacency is most of what stops the wrong one being picked, so the
    // grouping is the assertion — not the order the file happened to hold.
    expect(kinds).toEqual(['name', 'name', 'email', 'github']);
  });

  test('keeps declaration order within a kind, because that is the ranking', async () => {
    const text = await textOf(DECLARED);

    expect(text.indexOf('Ada')).toBeLessThan(text.indexOf('A. Lovelace'));
  });

  test('says that the first of several is the default', async () => {
    // Without this a model handed two names picks by position anyway. Being
    // told that position is what it means is the difference between a guess and
    // an instruction.
    expect(await textOf(DECLARED)).toContain('the first is the default');
  });

  test('does not offer a ranking when there is nothing to rank', async () => {
    const text = await textOf([{ kind: 'name', value: 'Ada' }]);

    expect(text).not.toContain('the first is the default');
    expect(text).toContain('Use these as written');
  });
});

describe('a profile that declares nothing', () => {
  test('is a listing, not a failure', async () => {
    const text = await textOf([]);

    expect(text).toContain('declares no identity');
  });

  test('tells the caller to ask rather than to invent one', async () => {
    // The failure mode is unchanged by there being nothing here: a model that
    // needs a name and finds none will compose one. This is the only place that
    // can say not to.
    expect(await textOf([])).toContain('do not invent one');
  });

  test('names the command that would declare one', async () => {
    // The owner runs it, not the agent — but an agent that can quote the exact
    // line is the difference between a useful answer and "ask your admin".
    expect(await textOf([])).toContain('lanes link identity add');
  });
});

describe('kinds are the owner’s to choose', () => {
  test('reports a kind this project has never heard of', async () => {
    // The schema takes any identifier deliberately: shipping an enum would mean
    // a release every time someone wants a kind we did not think of.
    const text = await textOf([
      { kind: 'pronouns', value: 'they/them' },
      { kind: 'linkedin', value: 'in/example' },
    ]);

    expect(text).toContain('pronouns');
    expect(text).toContain('they/them');
    expect(text).toContain('linkedin');
  });
});
