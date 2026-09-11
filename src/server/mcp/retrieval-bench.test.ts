import { describe, expect, test } from 'bun:test';
import { CORPUS } from './ranking-corpus.ts';
import { QUERIES } from './ranking-queries.ts';
import { searchCapabilities } from './search-index.ts';

/**
 * What retrieval costs today, printed rather than merely asserted.
 *
 * A pass/fail test tells you a threshold held. It does not tell you that
 * top-one accuracy slid from 100% to 91% while staying above 90%, or that the
 * answer to a common question doubled in size. Both are the kind of drift that
 * arrives one release at a time and is only ever visible against the release
 * before it.
 *
 * So this prints a table every run and asserts the floors. Run it alone to read
 * the numbers:
 *
 *     bun run bench:retrieval
 *
 * The recorded figures below are the measurement this work started from, on the
 * same corpus. Update them deliberately, in the same commit as whatever moved
 * them, so the diff carries the reason.
 */

/**
 * Where retrieval stood before any of this — the number to beat, not to keep.
 *
 * Measured on the corpus as it was: eleven providers, 51 capabilities, sixteen
 * questions. The corpus has since grown to the depth a real endpoint has, so the
 * deltas printed against this are across two different surfaces and read as
 * larger than the improvement was. Kept anyway, because the alternative is
 * re-running the pre-ranking code against the new corpus to manufacture a
 * comparison nobody ever measured.
 */
const BASELINE = { top1: 31, top3: 63, schema: 81, bytes: 4_063 } as const;

/**
 * And the same three, measured against the deployed endpoint rather than this
 * corpus, on the query the work started from. Kept because a fixture is a model
 * of a surface and this is the surface: eleven providers, two mail accounts,
 * descriptions written by their vendors rather than by us.
 *
 *   "latest email in inbox"    before: 27 matches, 11,893 B, schemaless tail
 *                               after:  6 matches,  5,815 B, every match callable
 *   tools advertised           before: 28, none carrying behaviour hints
 *                               after:  28, all four hints on every one
 */

/**
 * Floors, set below today's measurement so ordinary noise does not fail CI.
 *
 * These read 90/95/90 while the corpus was 51 capabilities and sixteen
 * questions. Neither the ranking nor the floors moved to bring them here: the
 * corpus did, and 56/72 is what the same code scores against a surface shaped
 * like a deployed one. `ranking.test.ts` names every miss behind these numbers,
 * which is the guard that actually catches a regression — a percentage can hold
 * while the cases behind it are swapped.
 */
const FLOOR = { top1: 55, top3: 70, schema: 70 } as const;

/** The size of an answer matters as much as its accuracy — it is context spent. */
const BYTE_BUDGET = 16 * 1024;

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

type Measurement = {
  readonly top1: number;
  readonly top3: number;
  readonly schema: number;
  readonly bytes: number;
  readonly worst: { readonly query: string; readonly bytes: number };
};

function measure(): Measurement {
  let top1 = 0;
  let top3 = 0;
  let schema = 0;
  let bytes = 0;
  let worst = { query: '', bytes: 0 };

  for (const { query, expect: want } of QUERIES) {
    const answer = searchCapabilities(query, CORPUS);
    const order = ranked(answer);
    const wanted = typeof want === 'string' ? [want] : want;
    const at = order.findIndex((id) => wanted.includes(id));
    const detailed = (answer.match(/^capability: /gm) ?? []).length;

    if (at === 0) top1++;
    if (at >= 0 && at < 3) top3++;
    if (at >= 0 && at < detailed) schema++;

    bytes += answer.length;
    if (answer.length > worst.bytes) worst = { query, bytes: answer.length };
  }

  const n = QUERIES.length;
  return {
    top1: Math.round((100 * top1) / n),
    top3: Math.round((100 * top3) / n),
    schema: Math.round((100 * schema) / n),
    bytes: Math.round(bytes / n),
    worst,
  };
}

function arrow(now: number, then: number, unit = '%'): string {
  const delta = now - then;
  const sign = delta > 0 ? '+' : '';
  return `${String(now).padStart(5)}${unit}  (was ${then}${unit}, ${sign}${delta})`;
}

describe('retrieval benchmark', () => {
  test('accuracy and answer size, against the recorded baseline', () => {
    const now = measure();

    console.log(
      [
        '',
        `  retrieval over ${CORPUS.size} capabilities, ${QUERIES.length} questions`,
        '  ' + '─'.repeat(58),
        `  answer ranks first        ${arrow(now.top1, BASELINE.top1)}`,
        `  answer in the first three ${arrow(now.top3, BASELINE.top3)}`,
        `  answer carries a schema   ${arrow(now.schema, BASELINE.schema)}`,
        `  mean answer size          ${arrow(now.bytes, BASELINE.bytes, ' B')}`,
        `  largest answer            ${String(now.worst.bytes).padStart(5)} B  "${now.worst.query}"`,
        '  ' + '─'.repeat(58),
        '',
      ].join('\n'),
    );

    expect(now.top1).toBeGreaterThanOrEqual(FLOOR.top1);
    expect(now.top3).toBeGreaterThanOrEqual(FLOOR.top3);
    expect(now.schema).toBeGreaterThanOrEqual(FLOOR.schema);
  });

  /**
   * Context spent is the other half of the cost, and the half that grows
   * quietly. An answer that ranks perfectly and costs 40 KB has moved the
   * problem rather than solved it.
   */
  test('no single answer exceeds the response budget', () => {
    const over = QUERIES.map(({ query }) => ({ query, bytes: searchCapabilities(query, CORPUS).length }))
      .filter(({ bytes }) => bytes > BYTE_BUDGET)
      .map(({ query, bytes }) => `${query}: ${bytes} B`);

    expect(over).toEqual([]);
  });

  /**
   * The ranking is a linear scan, and it runs inside a request. A thousand
   * capabilities is roughly four times the largest surface measured on a real
   * endpoint, so this is headroom rather than a target.
   *
   * Asserted loosely on purpose: a tight timing assertion in CI fails on a
   * loaded runner and teaches everyone to ignore it.
   */
  test('ranking stays fast enough to sit on a request path', () => {
    const wide = new Map(CORPUS);
    let n = 0;
    while (wide.size < 1_000) {
      for (const [id, entry] of CORPUS) {
        if (wide.size >= 1_000) break;
        wide.set(`filler${n++}.${id.split('.').slice(1).join('.')}`, entry);
      }
    }

    const started = performance.now();
    for (const { query } of QUERIES) searchCapabilities(query, wide);
    const each = (performance.now() - started) / QUERIES.length;

    console.log(`  ranking ${wide.size} capabilities: ${each.toFixed(1)} ms per query\n`);
    expect(each).toBeLessThan(250);
  });
});
