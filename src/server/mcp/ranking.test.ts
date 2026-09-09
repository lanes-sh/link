import { describe, expect, test } from 'bun:test';
import { CORPUS, QUERIES } from './ranking-corpus.ts';
import { searchCapabilities } from './search-index.ts';

/**
 * Whether the search answers the question, measured rather than spot-checked.
 *
 * `search-index.test.ts` pins behaviours one at a time and is the right shape
 * for them. This asks a different question — *how often is the answer right* —
 * because the failure that prompted the work was not a behaviour anyone had
 * asserted wrongly. Every one of those tests passed while a real endpoint
 * answered "latest email in inbox" with a release-notes tool and three tools for
 * handling drafts.
 *
 * Recorded against this corpus before any change: **top-1 31%, top-3 63%**.
 */

/** The ordered capability ids an answer names, best first. */
function ranked(answer: string): string[] {
  const ids: string[] = [];
  for (const line of answer.split('\n')) {
    const detailed = line.match(/^capability: (\S+)$/);
    if (detailed?.[1] !== undefined) ids.push(detailed[1]);
    const listed = line.match(/^- `([^`]+)`/);
    if (listed?.[1] !== undefined) ids.push(listed[1]);
  }
  return ids;
}

function place(query: string, expected: string | readonly string[]): number {
  const wanted = typeof expected === 'string' ? [expected] : expected;
  return ranked(searchCapabilities(query, CORPUS)).findIndex((id) => wanted.includes(id));
}

describe('how often the search is right', () => {
  /**
   * Reported as a fraction rather than asserted case by case, so a change that
   * trades one query for another shows up as a number moving rather than as a
   * test that has to be edited to keep passing.
   */
  test('the answer ranks first for at least nine questions in ten', () => {
    const missed = QUERIES.filter(({ query, expect: want }) => place(query, want) !== 0).map(
      ({ query }) => query,
    );

    // "my todo list" is the one that misses, and it is genuinely ambiguous:
    // `tasklists.list` returns the caller's task *lists*, which a query naming
    // "list" can honestly be read as asking for. Left as a miss rather than
    // written into the expectations, so the number stays comparable.
    expect(missed).toEqual(['my todo list']);
    expect((100 * (QUERIES.length - missed.length)) / QUERIES.length).toBeGreaterThanOrEqual(90);
  });

  test('the answer is in the first three for at least nineteen in twenty', () => {
    const outside = QUERIES.filter(({ query, expect: want }) => {
      const at = place(query, want);
      return at < 0 || at >= 3;
    });

    expect(outside.map(({ query }) => query)).toEqual([]);
  });

  /**
   * The one that actually happened, kept as its own case because a percentage
   * can stay green while the case that motivated it regresses.
   *
   * `latest` is rare and sits in a release tool's *name*; `email` and `inbox`
   * are common and sit in every mail tool's *description*. Ranking on rarity
   * alone answers with the release tool, which is what a deployed endpoint did.
   */
  test('a rare modifier does not outrank the subject of the question', () => {
    const order = ranked(searchCapabilities('latest email in inbox', CORPUS));

    expect(order[0]).not.toBe('forge.get_latest_release');
    expect(order[0]).toMatch(/messages/i);
  });

  /**
   * The other half of that fix, which is the half that could quietly break: a
   * query whose subject really is a release must still find one.
   */
  test('and the modifier still wins when it is the subject', () => {
    expect(ranked(searchCapabilities('latest release', CORPUS))[0]).toBe('forge.get_latest_release');
  });

  /**
   * Reading one thing by an identifier cannot answer a question that supplies
   * no identifier — the caller would have to already have what they are asking
   * for. So enumerating outranks fetching whenever the query asks for "the
   * latest" or "my" anything.
   */
  test('enumerating beats fetching when the caller has no identifier', () => {
    for (const query of ['latest email in inbox', 'what meetings do i have', 'find a document']) {
      expect(ranked(searchCapabilities(query, CORPUS))[0]).not.toMatch(/\.get$|get[A-Z]/);
    }
  });

  /**
   * Ranking is not authorisation, so this is not a safety control. It is that a
   * wrong first answer costs a turn, and the turn is worse when what it offers
   * is a deletion the caller then has to decline.
   */
  test('an ambiguous write does not offer to destroy something', () => {
    expect(ranked(searchCapabilities('schedule an appointment', CORPUS))[0]).toBe(
      'agenda.events.insert',
    );
  });
});

/**
 * When more than one account can answer, both are offered.
 *
 * A real endpoint with two mail accounts answered "read most recent email in
 * mailbox" with exactly one match. The reason was not a ranking error — the
 * winning capability is *authored*, so its description says "mailbox", "most
 * recent" and "reading" in those words and matched all five terms, while the
 * other account's generated description says none of them and matched two. The
 * gap was wide enough that the relevance cut removed the second account
 * entirely.
 *
 * Which mailbox the caller meant is not something this endpoint knows. Offering
 * one of them and calling it the answer is worse than offering both and letting
 * the caller pick, which is what the `reachable:` line on every result is for.
 */
describe('when two accounts could answer', () => {
  const providersIn = (query: string): string[] => [
    ...new Set(
      searchCapabilities(query, CORPUS)
        .split('\n')
        .flatMap((line) => {
          const found = line.match(/^capability: (\S+)$/);
          return found?.[1] ? [found[1].split('.')[0] as string] : [];
        }),
    ),
  ];

  test('a mail question reaches both mailboxes, not just the better-worded one', () => {
    const answered = providersIn('read most recent email in mailbox');

    expect(answered).toContain('postbox');
    expect(answered).toContain('mailhub');
  });

  /**
   * Breadth before depth: every provider that matched is offered before any
   * provider gets a second slot. Otherwise the better-worded account fills the
   * answer with three of its own operations and the other never appears.
   */
  test('each account is offered before any account is offered twice', () => {
    const ids = searchCapabilities('latest email in inbox', CORPUS)
      .split('\n')
      .flatMap((line) => {
        const found = line.match(/^capability: (\S+)$/);
        return found?.[1] ? [found[1].split('.')[0] as string] : [];
      });

    expect(new Set(ids).size).toBe(ids.length);
  });

  /** And a question only one provider can answer still gets depth from it. */
  test('a question with one plausible provider still gets its detail', () => {
    expect(providersIn('leads in the pipeline')).toEqual(['acme_crm']);
  });
});
