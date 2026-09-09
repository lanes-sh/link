/**
 * Measure one checkout's ranker against the shared corpus, as one JSON line.
 *
 * `compare.ts` copies this into whatever checkout it is measuring, so every
 * ranker is measured by identical code over identical data. It imports through
 * relative paths for that reason: it runs from `bench/` here and from the
 * repository root there, and `#`-mapped imports would resolve to the checkout
 * being measured rather than to this one — which is the point.
 */
import { readFileSync } from 'node:fs';
import { searchCapabilities } from '../src/server/mcp/search-index.ts';
import type { MergedCapability } from '../src/server/mcp/visibility.ts';

const corpus = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  entries: { id: string; title: string; description: string; properties: string[]; required: string[] }[];
  queries: { query: string; expect: string[]; kind: string }[];
};

const merged = new Map<string, MergedCapability>(
  corpus.entries.map((entry) => [
    entry.id,
    {
      reachable: new Map([['personal', [`${entry.id.split('.')[0]}.acct1`]]]),
      capability: undefined,
      discovered: {
        name: 'ignored',
        title: entry.title,
        description: entry.description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(entry.properties.map((n) => [n, { type: 'string' }])),
          required: entry.required,
        },
      },
    } as unknown as MergedCapability,
  ]),
);

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

function measure(questions: typeof corpus.queries) {
  let top1 = 0, top3 = 0, schema = 0, found = 0, bytes = 0, reciprocal = 0;
  const misses: { query: string; at: number; got: string }[] = [];

  for (const { query, expect } of questions) {
    const answer = searchCapabilities(query, merged);
    const order = ranked(answer);
    const at = order.findIndex((id) => expect.includes(id));
    const detailed = (answer.match(/^capability: /gm) ?? []).length;

    if (at === 0) top1++;
    if (at >= 0 && at < 3) top3++;
    if (at >= 0) { found++; reciprocal += 1 / (at + 1); }
    if (at >= 0 && at < detailed) schema++;
    if (at !== 0) misses.push({ query, at, got: order[0] ?? '(nothing)' });
    bytes += answer.length;
  }

  const n = questions.length;
  return {
    n,
    top1: Math.round((100 * top1) / n),
    top3: Math.round((100 * top3) / n),
    schema: Math.round((100 * schema) / n),
    recall: Math.round((100 * found) / n),
    mrr: Number((reciprocal / n).toFixed(3)),
    bytes: Math.round(bytes / n),
    misses,
  };
}

// Warm anything memoised, then time the steady state.
for (const { query } of corpus.queries) searchCapabilities(query, merged);
const started = performance.now();
for (const { query } of corpus.queries) searchCapabilities(query, merged);
const perQuery = (performance.now() - started) / corpus.queries.length;

const cold = (() => {
  const started2 = performance.now();
  searchCapabilities('first query on a fresh index', new Map(merged));
  return performance.now() - started2;
})();

console.log(JSON.stringify({
  label: process.argv[3] ?? 'unknown',
  all: measure(corpus.queries),
  reads: measure(corpus.queries.filter((q) => q.kind === 'read')),
  msPerQuery: Number(perQuery.toFixed(2)),
  msFirstQuery: Number(cold.toFixed(1)),
}));
