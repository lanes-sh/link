import { describe, expect, test } from 'bun:test';
import { CORPUS, QUERIES, READS } from './bench-corpus.ts';
import { searchCapabilities } from './search-index.ts';

/**
 * What retrieval costs, printed rather than merely asserted.
 *
 * A pass/fail test tells you a threshold held. It does not tell you that
 * top-one accuracy slid from 52% to 45% while staying above a floor, or that
 * the answer to a common question doubled in size. Both are the kind of drift
 * that arrives one release at a time and is only ever visible against the
 * release before it.
 *
 * So this prints a table every run and asserts floors under it:
 *
 *     bun run bench:retrieval
 *
 * The recorded figures are measurements, taken on this corpus, by
 * `bench/compare.ts`. Update them deliberately, in the same commit as whatever
 * moved them, so the diff carries the reason.
 */

/**
 * The two rankers this one is answerable to, on this corpus.
 *
 * `lexical` is what 0.11.2 serves. `tuned` is the hand-tuned lexical ranking of
 * #202 — an IDF weighting, a synonym table, a verb table and a plural test —
 * measured from its own branch by the same harness over the same fixture. Both
 * are here because "better than before" is a weak claim when somebody else
 * improved the same number a different way, and because the interesting result
 * is not that this wins but *where*: #202 returns a third fewer bytes and finds
 * the answer at all far less often.
 */
const RECORDED = {
  lexical: { top1: 29, top3: 51, mrr: 0.441, recall: 83 },
  tuned: { top1: 43, top3: 63, mrr: 0.515, recall: 63 },
} as const;

/** Floors, set below today's measurement so ordinary noise does not fail CI. */
const FLOOR = { top1: 45, top3: 62, recall: 85, mrr: 0.55 } as const;

/** An answer is context spent, and the budget is what stops accuracy buying it. */
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

function measure(questions: readonly { query: string; expect: string[] }[]) {
  let top1 = 0;
  let top3 = 0;
  let schema = 0;
  let found = 0;
  let reciprocal = 0;
  let bytes = 0;
  let worst = { query: '', bytes: 0 };

  for (const { query, expect: wanted } of questions) {
    const answer = searchCapabilities(query, CORPUS);
    const order = ranked(answer);
    const at = order.findIndex((id) => wanted.includes(id));
    const detailed = (answer.match(/^capability: /gm) ?? []).length;

    if (at === 0) top1++;
    if (at >= 0 && at < 3) top3++;
    if (at >= 0 && at < detailed) schema++;
    if (at >= 0) {
      found++;
      reciprocal += 1 / (at + 1);
    }
    bytes += answer.length;
    if (answer.length > worst.bytes) worst = { query, bytes: answer.length };
  }

  const n = questions.length;
  return {
    top1: Math.round((100 * top1) / n),
    top3: Math.round((100 * top3) / n),
    schema: Math.round((100 * schema) / n),
    recall: Math.round((100 * found) / n),
    mrr: Number((reciprocal / n).toFixed(3)),
    bytes: Math.round(bytes / n),
    worst,
  };
}

function against(now: number, lexical: number, tuned: number, unit = '%'): string {
  return `${String(now).padStart(6)}${unit}   ${String(lexical).padStart(6)}${unit}   ${String(tuned).padStart(6)}${unit}`;
}

describe('retrieval benchmark', () => {
  test('accuracy and answer size, against both recorded rankers', () => {
    const now = measure(QUERIES);
    const reads = measure(READS);

    console.log(
      [
        '',
        `  ${CORPUS.size} capabilities, ${QUERIES.length} questions (${READS.length} of them reads)`,
        '  ' + '─'.repeat(62),
        '                              hybrid   lexical     #202',
        `  answer ranks first        ${against(now.top1, RECORDED.lexical.top1, RECORDED.tuned.top1)}`,
        `  answer in the first three ${against(now.top3, RECORDED.lexical.top3, RECORDED.tuned.top3)}`,
        `  answer found at all       ${against(now.recall, RECORDED.lexical.recall, RECORDED.tuned.recall)}`,
        `  mean reciprocal rank      ${against(now.mrr, RECORDED.lexical.mrr, RECORDED.tuned.mrr, ' ')}`,
        '  ' + '─'.repeat(62),
        `  reads only, ranks first   ${String(reads.top1).padStart(6)}%`,
        `  reads only, first three   ${String(reads.top3).padStart(6)}%`,
        `  answer carries a schema   ${String(now.schema).padStart(6)}%`,
        `  mean answer size          ${String(now.bytes).padStart(6)} B`,
        `  largest answer            ${String(now.worst.bytes).padStart(6)} B  "${now.worst.query}"`,
        '  ' + '─'.repeat(62),
        '',
      ].join('\n'),
    );

    expect(now.top1).toBeGreaterThanOrEqual(FLOOR.top1);
    expect(now.top3).toBeGreaterThanOrEqual(FLOOR.top3);
    expect(now.recall).toBeGreaterThanOrEqual(FLOOR.recall);
    expect(now.mrr).toBeGreaterThanOrEqual(FLOOR.mrr);
  });

  /**
   * Beating the ranking it replaces on the number that was the point.
   *
   * Asserted rather than left to the printed table, because a change that
   * quietly gave back the vocabulary gap would still pass every floor above.
   */
  test('both recorded rankers are beaten on rank and on recall', () => {
    const now = measure(QUERIES);
    expect(now.mrr).toBeGreaterThan(RECORDED.lexical.mrr);
    expect(now.mrr).toBeGreaterThan(RECORDED.tuned.mrr);
    expect(now.recall).toBeGreaterThan(RECORDED.tuned.recall);
  });

  test('no single answer exceeds the response budget', () => {
    const over = QUERIES.map(({ query }) => ({ query, bytes: searchCapabilities(query, CORPUS).length }))
      .filter(({ bytes }) => bytes > BYTE_BUDGET)
      .map(({ query, bytes }) => `${query}: ${bytes} B`);

    expect(over).toEqual([]);
  });

  /**
   * Both halves of the ranking sit on a request path, and one of them reads a
   * four-megabyte file the first time it is asked. A thousand capabilities is
   * roughly four times the largest surface measured on a real endpoint.
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

    const cold = performance.now();
    searchCapabilities('first query, index not yet built', wide);
    const built = performance.now() - cold;

    const started = performance.now();
    for (const { query } of QUERIES) searchCapabilities(query, wide);
    const each = (performance.now() - started) / QUERIES.length;

    console.log(`  ${wide.size} capabilities: ${built.toFixed(0)} ms to index, ${each.toFixed(1)} ms per query\n`);
    expect(each).toBeLessThan(250);
    expect(built).toBeLessThan(4_000);
  });
});
