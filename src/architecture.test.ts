import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * The rules the folder layout is supposed to express, asserted rather than
 * hoped for.
 *
 * Two of these used to be enforced structurally and are not any more. Thirteen
 * `package.json` files each listed their dependencies, so `#audit` importing
 * `#server` was a resolution error; one package makes it merely wrong. And
 * twelve providers in one file meant nobody noticed vendor knowledge leaking
 * into the transports, because there was no boundary to leak across.
 *
 * A test is a stronger check than the package graph was — it sees individual
 * files where `dependencies` saw whole packages — but only while it exists. If
 * one of these fails, the fix is almost never to relax the rule.
 */

const SRC = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  };

  await walk(SRC);
  return found.sort();
}

/** Every `#component` a file imports from. */
function componentsImportedBy(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/from '#([a-z-]+)(?:\/[^']*)?'/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/** Which component a path belongs to. `src/server/mcp/build.ts` → `server`. */
function componentOf(path: string): string {
  return relative(SRC, path).split('/')[0]!;
}

// ---------------------------------------------------------------------------
// 1. Dependency direction
// ---------------------------------------------------------------------------

/**
 * What each component may import.
 *
 * Read it as layers: storage contracts at the bottom, then the provider-facing
 * declaration surface, then the machinery that decides what exists and how a
 * call runs, then the two entry points. Nothing above imports a backend
 * directly — that is what `deployments` is for, and only `profile` opens one.
 */
const MAY_IMPORT: Record<string, readonly string[]> = {
  audit: [],
  // `stores` because issuing a token means remembering it, and a registered
  // client, an authorization code and a live token all outlive the instance
  // that created them — Cloud Run replaces instances between requests, so
  // in-memory would mean every connector logging out at random. It stays
  // downward: `stores` is at the bottom and `secrets` already depends on it.
  auth: ['secrets', 'stores'],
  policy: ['audit'],
  stores: ['audit'],
  secrets: ['stores'],
  connectivity: ['audit', 'secrets', 'stores', 'registry'],
  profile: ['deployments', 'providers', 'secrets', 'stores'],
  // Reconcile writes connection rows and reports which credentials are missing,
  // so it reaches both stores; it never opens one.
  registry: ['audit', 'connectivity', 'policy', 'profile', 'secrets', 'stores'],
  dispatch: ['audit', 'auth', 'connectivity', 'policy', 'profile', 'registry', 'secrets', 'stores'],
  providers: ['audit', 'connectivity', 'profile', 'secrets', 'stores'],
  // `audit` because an adapter implements the log; `cli` and `registry`
  // because a deployment owns its own rollout command.
  deployments: ['audit', 'cli', 'profile', 'registry', 'secrets', 'stores'],
  server: ['auth', 'connectivity', 'dispatch', 'policy', 'profile', 'registry', 'cli'],
  // `audit` because the runtime carries the log and `audit tail` renders it.
  // It used to reach both through `#stores/state`, which was the RuntimeState
  // contract owning something that was never runtime state; now that the log
  // is its own store, the dependency is stated instead of laundered. It stays
  // downward — `audit` sits at the bottom and imports nothing.
  cli: [
    'audit', 'auth', 'connectivity', 'deployments', 'dispatch', 'policy',
    'profile', 'providers', 'registry', 'secrets', 'server', 'stores',
  ],
};

describe('dependency direction', () => {
  test('no component imports one it is not allowed to', async () => {
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      // A test wires whatever it needs to exercise the thing it covers, and a
      // harness exists to do exactly that — neither ships, so neither is part
      // of the dependency graph this rule is about.
      if (path.endsWith('.test.ts') || path.endsWith('harness.ts')) continue;

      const from = componentOf(path);
      const allowed = MAY_IMPORT[from];
      if (!allowed) continue;

      for (const to of componentsImportedBy(await readFile(path, 'utf8'))) {
        if (to === from || allowed.includes(to)) continue;
        violations.push(`${relative(SRC, path)} imports #${to}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Vendor code lives in the provider that owns it
// ---------------------------------------------------------------------------

/**
 * The rule from ADR-008, made mechanical: **protocol code, not vendor code**.
 *
 * A transport may know what CalDAV does and must not know that iCloud exists.
 * Where a vendor genuinely behaves differently, the difference is a declared
 * field on that transport's schema, set by the provider that needs it — see
 * `setup.troubleshooting`, `dav.max_range_days`, and `fs.placeholder`.
 *
 * Comments are exempt, deliberately. "iCloud's contacts host returns a 207
 * whose propstat is 404" is the reason a piece of protocol code is shaped the
 * way it is, and deleting that sentence to satisfy a grep would make the code
 * worse. What must not appear is a vendor name the code *branches on* or
 * *prints*.
 *
 * Four vendors are deliberately absent: Close, Remote, Resend, and Workable.
 * Each is a provider like any other, but "close" is what a socket does,
 * "remote" is half the vocabulary of a transport, and "resend" and "workable"
 * both appear in ordinary prose about retries and schemas. Matching on them
 * would flag scores of lines of protocol code, and a detector suppressed
 * everywhere detects nothing — this list is a sample of names likely to leak,
 * not a roll of every provider.
 */
const VENDORS =
  /\b(gmail|icloud|notion|linear|apple|google|dropbox|fastmail|reddit|bunq|discord|asana|stripe|sentry|figma|canva|todoist|clickup|monday|airtable|miro|calendly|zapier|paypal|square|mercury|vercel|netlify|supabase|neon|prisma|sanity|webflow|wix|datadog|grafana|fireflies|gamma|jam|cloudflare|algolia|amplitude|apify|attio|betterstack|brightdata|buildkite|circleci|contentful|expensify|flagsmith|heroku|hygraph|insightly|klaviyo|mixpanel|mux|navan|paddle|posthog|ramp|recurly|replicate|riverside|rootly|rudderstack|salesloft|shortcut|storyblok|tavily|vimeo|whimsical|zoho|yahoo|microsoft|outlook|onedrive|entra|atlassian|hubspot|jira|confluence)\b/i;

/**
 * Where the rule bites: the machinery a request passes through.
 *
 * Not the whole tree, because the rule is about *protocol code*, and two other
 * kinds of vendor mention are legitimate:
 *
 * - **Examples.** `lanes link policy allow gmail.*` in the help, and `must be
 *   "*", "gmail.*", or "gmail.send_message"` in a schema error. A concrete
 *   example teaches faster than an abstract one, and neither routes on anything.
 * - **`profile/secret-detection.ts`.** It knows that a config value starting
 *   `ya29.` is a leaked Google token. That is vendor knowledge, and it belongs
 *   to no provider: it has to catch a secret pasted into a config file whether
 *   or not the provider that issued it is installed.
 *
 * What would still be a violation inside these paths is the thing this rule
 * exists for — a branch on a vendor, or a message that assumes one.
 */
const VENDOR_SCOPE = ['connectivity/', 'dispatch/', 'registry/', 'secrets/', 'server/', 'stores/'];

/**
 * Blank out comments, keeping line numbers.
 *
 * Removing them would shift every number after the first block comment, and a
 * violation reported at the wrong line is worse than one reported vaguely.
 */
function codeOnly(source: string): string {
  const lines = source.split('\n');
  let inBlock = false;

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        return '';
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlock = true;
        return '';
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      return line.replace(/\/\/.*$/, '');
    })
    .join('\n');
}

describe('vendor knowledge stays in its provider', () => {
  test('no vendor name appears in the code a request passes through', async () => {
    const violations: string[] = [];

    for (const path of await sourceFiles()) {
      const shown = relative(SRC, path);
      if (shown.endsWith('.test.ts')) continue;
      if (!VENDOR_SCOPE.some((prefix) => shown.startsWith(prefix))) continue;

      for (const [index, line] of codeOnly(await readFile(path, 'utf8')).split('\n').entries()) {
        const hit = line.match(VENDORS);
        if (hit) violations.push(`${shown}:${index + 1} names "${hit[0]}"`);
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. File size
// ---------------------------------------------------------------------------

/**
 * A budget, not a law.
 *
 * Thirteen files were over 400 lines and the largest was 928. Every one of them
 * had a seam in it that was invisible at that length — `dav/index.ts` was 130
 * lines of capability declaration wrapped around three lines of behaviour, and
 * the MCP surface hid the one function that decides what a caller may see among
 * schema sanitisers and URI helpers.
 *
 * The number is arbitrary; what is not arbitrary is that passing it is a prompt
 * to look for the seam. Raising it for a file that genuinely has none is a fine
 * outcome — doing so silently is not, which is why the limit is here rather
 * than in a linter config.
 */
const MAX_LINES = 400;

/**
 * The files still over the budget, named so the debt is visible.
 *
 * An allowlist rather than a higher number, because the two say different
 * things: a higher number says 450 lines is fine, and this says these five are
 * not yet done. Adding to it should feel like the concession it is; removing
 * from it is the point.
 *
 * The CLI used to be most of this list — five entries, `connect.ts` alone at
 * 944 lines covering setup prompts, the OAuth dance, identity resolution, and
 * config writing. It was the piece of the `src/` restructure that had not
 * happened, and it has now: `connect/`, `operate/`, `owner/` and `runtime/`
 * each split along the seam every other split here found, with `main.ts`
 * shedding its usage text and argv parsing.
 *
 * Two more left when the audit log did. `deployments/adapters/postgres.ts` and
 * `stores/database/conformance.ts` were both carrying a second subject — a log
 * that was never runtime state, kept inside the RuntimeState contract — and moving
 * it out took them to 322 and 290 lines without either being split. That is
 * the seam the budget exists to point at: they were not too long, they were
 * two things.
 *
 * `server/endpoint.ts` came off this list, and how is the point. It was the one
 * entry no single change earned: 371 lines on `main` and under the budget on all
 * four branches that were open at once, crossing at 416 only when they were
 * integrated, gaining the target-aware authorization surface from one and the
 * dashboard route from another. The note here named the second as the seam — the
 * dashboard was a whole surface reached over the same port — and said to cut
 * there rather than by line count. ADR-053 cut there by deleting it, and the
 * file came back under on its own. An exemption that names a seam is a debt
 * with an address, which is the only kind that gets paid.
 *
 * `server/harness.ts` is the one with a seam already
 * visible: `startStdioHarness` and `StdioHarness` are 135 lines serving the
 * same profiles over a different transport, and only two tests import them.
 * It crossed the line by one, adding the target an endpoint runs as to the
 * authorization surface, and splitting it was a larger change than the one
 * that revealed it. Cut there when something needs to touch this file next.
 *
 * `profile/schema.ts` is `server/endpoint.ts` again, and a second occurrence is
 * what makes that a pattern rather than an accident. It was 385 lines, and two
 * branches open at once added ten net lines each — an `identity` block on the
 * config, and `allowed_origins` on the authorization block. Both were green,
 * because each was measured against a base without the other, and the merge
 * that put them together was the first thing to see 405. A budget that only one
 * branch at a time can check will keep finding this.
 *
 * Exempt rather than split, and this one is not a deferral. The file holds
 * seventeen Zod declarations and no functions at all: its length is the size of
 * the config format, not a count of responsibilities. The seam this budget
 * exists to point at is a second subject — what `deployments/adapters/postgres.ts`
 * and `stores/database/conformance.ts` each turned out to be — and there is no
 * second subject here to find. Splitting it by line count would put
 * `targetSchema` and `configSchema` in different files to satisfy an arithmetic
 * that is not measuring anything about them. What would earn a split is
 * something that is not a schema appearing beside them; that is the thing to
 * watch for, and it is visible in a diff.
 */
/**
 * `cli/main.ts` is the same case as `profile/schema.ts` above, and is exempt for
 * the same reason rather than as a deferral.
 *
 * It is one `switch` and nothing else — its own docstring says so: "the grammar
 * and nothing else: which word maps to which function". Its length is a count of
 * *commands*, which is a count of what this tool does, not of what this file is
 * responsible for. That is the argument this budget already accepts for a test
 * file two tests down: length that is cases rather than responsibilities, where
 * splitting scatters a subject.
 *
 * And splitting really would. Half a grammar means a reader asking "what does
 * `lanes link vault set` run" has two files to check and no rule saying which.
 * Every candidate cut — the owner-layer nouns, the deploy-side ones — is a
 * grouping this file deliberately does not make, because argv does not make it
 * either.
 *
 * What would earn a split is the thing that is not grammar appearing here: a
 * command implemented inline rather than dispatched to, or flag handling that
 * outgrows `argv.ts`. Both are visible in a diff. It crossed the line adding
 * `knowledge`, which is fourteen lines of the same shape as the twenty-seven
 * cases around it.
 */
const KNOWN_LONG = new Set([
  'cli/main.ts',
  'connectivity/transports/dav/ical.ts',
  'deployments/adapters/gcp-secret-manager.ts',
  'profile/schema.ts',
  'providers/memory/provider.ts',
  'server/harness.ts',
]);

describe('file size', () => {
  test('no source file is longer than the budget', async () => {
    const over: string[] = [];

    for (const path of await sourceFiles()) {
      const shown = relative(SRC, path);
      // A test is allowed to be long: its length is usually cases rather than
      // responsibilities, and splitting one by size scatters a subject.
      if (shown.endsWith('.test.ts') || KNOWN_LONG.has(shown)) continue;

      const lines = (await readFile(path, 'utf8')).split('\n').length;
      if (lines > MAX_LINES) over.push(`${shown} is ${lines} lines`);
    }

    expect(over).toEqual([]);
  });

  test('nothing on the known-long list has quietly disappeared', async () => {
    // So that deleting a file, rather than splitting it, does not leave a stale
    // exemption behind for the next long file to slip into.
    const paths = new Set((await sourceFiles()).map((path) => relative(SRC, path)));
    expect([...KNOWN_LONG].filter((known) => !paths.has(known))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Somebody's real name
// ---------------------------------------------------------------------------

/**
 * No real person's address, and no real cloud resource, in a public repository.
 *
 * This one is here because it already happened. Forty-five occurrences of the
 * owner's own email addresses, a second person's name, a live Google Cloud
 * project id and two globally-unique storage bucket names had to be scrubbed out
 * of thirteen files the week this went public. None of it was pasted carelessly:
 * writing the address you are actually testing with is the shortest path to a
 * passing test, and until this repository had an audience nothing was wrong with
 * it.
 *
 * So the rule is about the *domain*, not about spotting a name. `example.com`,
 * `example.org`, `example.net` and anything under `.test`, `.example` or
 * `.invalid` are reserved by RFC 2606 and RFC 6761 — they cannot be registered,
 * so an address at one cannot reach a person, cannot be credential-stuffed, and
 * cannot be indexed into somebody's inbox. Every other domain might belong to
 * someone.
 *
 * Prose is exempt by construction rather than by allowlist: a sentence about
 * `@gmail.com` as a *kind* of account has no local part in front of the `@`, so
 * it does not match, while the same domain with a name attached does. Explaining
 * what a domain means stays possible; addressing a made-up person at it does not.
 * (This comment is itself subject to the rule, which is why it does not spell
 * one out.)
 */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** RFC 2606 and RFC 6761: registered to nobody, ever. */
const RESERVED_DOMAIN = /^(example\.(com|org|net)|.+\.(test|example|invalid)|localhost)$/i;

/**
 * A service account is a machine, not a person.
 *
 * `lanes-link-run@my-project.iam.gserviceaccount.com` names no inbox, and the
 * shape is Google's rather than ours — `provision.ts` has to explain that
 * passing the whole address where an id belongs produces
 * `foo@bar.iam...@project.iam...`, which needs the literal to be legible. What
 * *did* leak here was the project id in the middle, and that is the placeholder
 * rule below, not this one.
 */
const MACHINE_DOMAIN = /\.iam(\.gserviceaccount\.com)?$/i;

/**
 * Vendored from Google by `bun run vendor:google`, and their examples are theirs.
 *
 * `gmail.v1.json` documents a search using an address at a registrable domain.
 * Editing it would be overwritten by the next vendor run, and a spec fetched from
 * Google is not where a leak of ours would land.
 */
const NOT_OURS = 'providers/google/specs/';

/** Every file a reader of the published repository can open. */
async function publishedFiles(): Promise<string[]> {
  const root = join(SRC, '..');
  const skip = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', 'coverage', 'data']);
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|md|json|ya?ml)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  };

  await walk(root);
  return found.sort();
}

/**
 * A deployment example names a real project until it names a placeholder.
 *
 * The bucket names are the reason this is separate from the address rule. A GCS
 * bucket name is one global namespace, so publishing the real one tells a reader
 * exactly which bucket to probe — and the deploy survey's own naming convention
 * then implies the project id from it. A project id is global in the same way.
 *
 * `service` is deliberately absent: a Cloud Run service name is scoped to its
 * project rather than to the world, and it is derived from the profile name by
 * `defaultServiceName`, so it was never the thing that leaked.
 *
 * Only fenced blocks in documentation are read. Prose is full of sentences like
 * "the thesis driving this project: curated memory", which is a colon and a word
 * and nothing to do with a deployment. The code is excluded too — it takes these
 * from config, and the tests need concrete strings to assert against.
 */
const DEPLOYMENT_VALUE = /^\s*(?:-\s*)?(project|bucket|service_account):\s*([^\s#{]+)/;
const PLACEHOLDER = /^(your-|example-|my-|lanes-link-demo|<|\$|\{)/i;

describe('no real identifiers', () => {
  test('every email address is at a domain reserved for documentation', async () => {
    const violations: string[] = [];

    for (const path of await publishedFiles()) {
      const shown = relative(SRC, path);
      if (shown.includes(NOT_OURS)) continue;

      for (const [index, line] of (await readFile(path, 'utf8')).split('\n').entries()) {
        for (const address of line.match(ADDRESS) ?? []) {
          const domain = address.slice(address.indexOf('@') + 1);
          if (RESERVED_DOMAIN.test(domain) || MACHINE_DOMAIN.test(domain)) continue;
          violations.push(`${shown}:${index + 1} — ${address} is at a registrable domain`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('a deployment example in the docs names a placeholder, not a real resource', async () => {
    const violations: string[] = [];

    for (const path of await publishedFiles()) {
      const shown = relative(SRC, path);
      if (!shown.includes('docs/')) continue;

      let fenced = false;

      for (const [index, line] of (await readFile(path, 'utf8')).split('\n').entries()) {
        if (line.trimStart().startsWith('```')) {
          fenced = !fenced;
          continue;
        }
        if (!fenced) continue;

        const match = line.match(DEPLOYMENT_VALUE);
        if (!match) continue;

        const [, key, value] = match as unknown as [string, string, string];
        // A service account carries its project in the middle, so judge that.
        const subject = key === 'service_account' ? (value.split('@')[1] ?? value) : value;
        if (PLACEHOLDER.test(subject)) continue;
        violations.push(`${shown}:${index + 1} — ${key}: ${value} does not read as a placeholder`);
      }
    }

    expect(violations).toEqual([]);
  });
});
