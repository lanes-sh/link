/**
 * Measure this ranking against another checkout's, over the same corpus.
 *
 * The numbers recorded in `bench-retrieval.test.ts` came from here, and the
 * point of committing it is that they can be checked rather than believed:
 *
 *     bun run bench:compare                       # this checkout alone
 *     bun run bench:compare <path> [<path>…]      # and each of these
 *
 * A path is any checkout of this repository — a worktree, or a clone at some
 * other branch. The corpus and this file are copied in, so every ranker is
 * measured by identical code over identical data. Nothing in the other
 * checkout is modified except two files that are removed again.
 */
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CORPUS = join(HERE, 'src/server/mcp/bench-corpus.json');

type Result = {
  label: string;
  all: Report;
  reads: Report;
  msPerQuery: number;
  msFirstQuery: number;
};
type Report = {
  n: number;
  top1: number;
  top3: number;
  schema: number;
  recall: number;
  mrr: number;
  bytes: number;
};

async function measureIn(root: string, label: string): Promise<Result | undefined> {
  const runner = join(root, '.bench-measure.ts');
  const corpus = join(root, '.bench-corpus.json');
  const ours = root === HERE;

  if (!ours) {
    if (!existsSync(join(root, 'src/server/mcp/search-index.ts'))) {
      console.error(`skip ${label}: not a checkout of this repository`);
      return undefined;
    }
    const source = await Bun.file(new URL('./measure.ts', import.meta.url)).text();
    await Bun.write(runner, source.replace(/'\.\.\/src\//g, "'./src/"));
    cpSync(CORPUS, corpus);
  }

  const proc = Bun.spawn(
    ['bun', 'run', ours ? join(HERE, 'bench/measure.ts') : runner, ours ? CORPUS : corpus, label],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  const out = await new Response(proc.stdout).text();
  const failed = await proc.exited;

  if (!ours) {
    rmSync(runner, { force: true });
    rmSync(corpus, { force: true });
  }

  if (failed !== 0 || !out.trim()) {
    console.error(`skip ${label}: measurement failed\n${(await new Response(proc.stderr).text()).slice(0, 400)}`);
    return undefined;
  }
  return JSON.parse(out) as Result;
}

async function labelFor(root: string): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const branch = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return branch || root.split('/').pop() || root;
}

const roots = [HERE, ...process.argv.slice(2)];
const results: Result[] = [];
for (const root of roots) {
  const measured = await measureIn(root, await labelFor(root));
  if (measured) results.push(measured);
}

const pad = (text: string | number, width: number) => String(text).padStart(width);
const name = Math.max(...results.map((r) => r.label.length), 8);

console.log(`\n  ${results[0]?.all.n ?? 0} questions over ${'166'} capabilities\n`);
console.log(
  `  ${'ranker'.padEnd(name)}  ${pad('top1', 5)} ${pad('top3', 5)} ${pad('recall', 7)} ${pad('mrr', 6)} ` +
    `${pad('reads1', 7)} ${pad('bytes', 6)} ${pad('ms/q', 6)}`,
);
console.log(`  ${'─'.repeat(name + 46)}`);
for (const r of results) {
  console.log(
    `  ${r.label.padEnd(name)}  ${pad(`${r.all.top1}%`, 5)} ${pad(`${r.all.top3}%`, 5)} ` +
      `${pad(`${r.all.recall}%`, 7)} ${pad(r.all.mrr, 6)} ${pad(`${r.reads.top1}%`, 7)} ` +
      `${pad(r.all.bytes, 6)} ${pad(r.msPerQuery, 6)}`,
  );
}
console.log('');
