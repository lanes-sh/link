/**
 * What the profile inventory listing costs against a real, populated workspace.
 *
 * ADR-083 put the listing on the slow clock and said, in as many words, that
 * this is "the one measurement the design turns on" — then did not supply one.
 * `INVENTORY_TTL_MS` has been argued only in the relative: twelve times the hot
 * clock, so that "the expensive listing stays rare". Twelve times a number is
 * not a price, and nothing here has ever measured the thing being avoided.
 *
 * The cost is not the profile count. `profilesRoot()` is a prefix, and every
 * profile's memory, assets, skills and entities live under it — so the listing
 * walks all of them on the way past and then throws the result away except for
 * the `<name>/profile.yaml` keys. On GCS that is one paginated request per
 * thousand objects; on a filesystem it is a recursive walk with a stat per
 * file. Either way it scales with how much the owner has stored, which is the
 * number that grows.
 *
 * Measured cold and then warm, because the second number is what a reader will
 * otherwise assume the first one was: a page cache or a warm connection makes
 * the same call look an order of magnitude cheaper than it is on the request
 * that actually pays for it.
 *
 * Takes the workspace the ordinary way, so it names no bucket and no project.
 * Not shipped: `package.json`'s `files` covers `bin`, `src` and `instructions`.
 *
 *     bun run inventory:cost                      # the resolved workspace
 *     LANES_LINK_DEV=0 bun run inventory:cost --workspace <name>
 */
import { resolveWorkspaceRoot } from '../src/profile/index.ts';
import { openTarget } from '../src/profile/index.ts';
import { workspaceFiles } from '../src/profile/files.ts';
import { layout } from '../src/profile/layout.ts';

const argv = process.argv.slice(2);
let workspace: string | undefined;
let rounds = 3;

for (let at = 0; at < argv.length; at += 1) {
  const arg = argv[at] ?? '';
  if (arg === '--workspace') workspace = argv[(at += 1)];
  else if (arg === '--rounds') rounds = Number(argv[(at += 1)]);
}

const home = resolveWorkspaceRoot();
const resolved = workspace ? await openTarget(home, workspace) : undefined;
const root = resolved?.workspaceRoot ?? home;

// Printed because nothing else distinguishes a dev workspace from the real one
// (CLAUDE.md), and a measurement attributed to the wrong store is worse than
// none — it would be quoted as the price of a bucket it never touched.
console.log(`workspace root  ${root}`);
console.log(`prefix          ${layout.profilesRoot()}/\n`);

const files = workspaceFiles(root);
const prefix = `${layout.profilesRoot()}/`;

const timings: number[] = [];
let objects = 0;
let profiles = 0;

for (let round = 0; round < Math.max(1, rounds); round += 1) {
  const started = performance.now();
  const entries = await files.list(prefix);
  const elapsed = performance.now() - started;
  timings.push(elapsed);

  objects = entries.length;
  profiles = new Set(
    entries
      .map((entry) => entry.key.slice(prefix.length).split('/'))
      .filter((parts) => parts.length === 2 && parts[1] === 'profile.yaml')
      .map((parts) => parts[0]!),
  ).size;

  const label = round === 0 ? 'cold' : `warm ${round}`;
  console.log(`  ${label.padEnd(6)}  ${elapsed.toFixed(0).padStart(6)} ms`);
}

const cold = timings[0]!;
const warm = timings.slice(1);
const warmest = warm.length > 0 ? warm.reduce((a, b) => a + b, 0) / warm.length : cold;

console.log(`\n  objects under the prefix  ${objects}`);
console.log(`  profiles found            ${profiles}`);
// The listing is paginated at a thousand objects per request, so this is the
// number of round trips a deployed target pays — the part that does not get
// cheaper on a faster machine.
console.log(`  pages (1000/request)      ${Math.max(1, Math.ceil(objects / 1000))}`);
console.log(`  cold                      ${cold.toFixed(0)} ms`);
console.log(`  warm (mean of ${warm.length})          ${warmest.toFixed(0)} ms`);
console.log(
  `\n  At INVENTORY_TTL_MS=60000 one instance pays the cold figure at most once a minute.`,
);
