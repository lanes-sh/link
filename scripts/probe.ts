/**
 * Ask the search a question and print what it would answer.
 *
 * The companion to `bench:retrieval`: that one measures whether ranking has
 * regressed, this one answers "what does it say to *this* query". Both run the
 * real ranking and rendering over the committed fixture corpus, so neither
 * needs a workspace, a credential, or a network — there is nothing here that
 * can reach an account.
 *
 * Not shipped: `package.json`'s `files` covers `bin`, `src` and `instructions`,
 * and this is none of them.
 */
import { CORPUS } from '../src/server/mcp/ranking-corpus.ts';
import { searchCapabilities } from '../src/server/mcp/search-index.ts';

const argv = process.argv.slice(2);
const words: string[] = [];
let limit: number | undefined;
let surface: 'full' | 'crunched' = 'full';

for (let at = 0; at < argv.length; at += 1) {
  const arg = argv[at] ?? '';
  if (arg === '--limit') limit = Number(argv[(at += 1)]);
  else if (arg === '--crunched') surface = 'crunched';
  else words.push(arg);
}

const query = words.join(' ');

if (query.length === 0) {
  console.log('Ask it something:\n');
  console.log('  bun run probe "latest email in inbox"');
  console.log('  bun run probe --limit 6 "move a file to a folder"');
  console.log('  bun run probe --crunched "archive a message"\n');
  process.exit(1);
}

const answer = searchCapabilities(query, CORPUS, surface, limit === undefined ? {} : { limit });

console.log(answer);
console.log('\n' + '─'.repeat(64));
console.log(
  `${CORPUS.size} capabilities searched · ${answer.length} B answered · surface ${surface}`,
);
