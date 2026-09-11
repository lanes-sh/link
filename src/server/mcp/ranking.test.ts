import { describe, expect, test } from 'bun:test';
import { CORPUS } from './ranking-corpus.ts';
import { QUERIES } from './ranking-queries.ts';
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
  /**
   * These numbers used to read 94% and 100%, and nothing about the ranking got
   * worse to make them 56% and 72%.
   *
   * The corpus did. It was eleven providers and 51 capabilities against sixteen
   * questions, where a deployed endpoint measured 278 capabilities (ADR-076) and
   * nobody asks it only sixteen things. Giving the providers the depth real APIs
   * have, adding a second calendar and a second issue tracker, and asking twenty
   * more questions is what moved it — each step measured on its own, and the
   * depth alone took top-1 from 94% to 88%.
   *
   * So the old number was a property of the fixture. It is written down here
   * rather than quietly replaced, because the honest floor is the one worth
   * defending and a benchmark that flatters is worse than none.
   */
  test('the answer ranks first for more than half the questions', () => {
    const missed = QUERIES.filter(({ query, expect: want }) => place(query, want) !== 0).map(
      ({ query }) => query,
    );

    // Named rather than counted, so a change that trades one miss for another
    // shows up as an edit here instead of a number that did not move.
    expect(missed).toEqual([
      'what meetings do i have',
      'find a document',
      'my todo list',
      'add a reminder',
      'files shared with me',
      'who has access to this file',
      'cancel a meeting',
      'reply in a thread',
      'bugs reported this week',
      'why did the build fail',
      'which version is deployed',
      'refund a customer',
      'how many signups last month',
      'move an issue to done',
      'save someone to my address book',
      'a meeting with attendees and a location',
    ]);
    expect((100 * (QUERIES.length - missed.length)) / QUERIES.length).toBeGreaterThanOrEqual(55);
  });

  test('the answer is in the first three for seven questions in ten', () => {
    const outside = QUERIES.filter(({ query, expect: want }) => {
      const at = place(query, want);
      return at < 0 || at >= 3;
    });

    expect(outside.map(({ query }) => query)).toEqual([
      'my todo list',
      'add a reminder',
      'files shared with me',
      'who has access to this file',
      'cancel a meeting',
      'bugs reported this week',
      'why did the build fail',
      'how many signups last month',
      'move an issue to done',
      'save someone to my address book',
    ]);
    expect((100 * (QUERIES.length - outside.length)) / QUERIES.length).toBeGreaterThanOrEqual(70);
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
    // The claim is about the *operation*, not the account. Two calendars now
    // answer this and the query names neither, so asserting one vendor asserted
    // a preference the endpoint has no basis for and failed the moment the
    // second one arrived. What must hold is that creating wins and deleting
    // does not appear at the head of the answer.
    const first = ranked(searchCapabilities('schedule an appointment', CORPUS))[0];

    expect(first).toBeDefined();
    expect(['agenda.events.insert', 'dayplan.events.create']).toContain(first as string);
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
