import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAdd } from '#cli/commands/profile.ts';
import { tokenIssue, tokenShow } from '#cli/commands/operate/token.ts';
import { primaryProfile } from '#cli/runtime.ts';
import { layout, MEMBERS_TTL_MS } from '#profile';
import { startEndpoint, type RunningEndpoint } from './endpoint.ts';
import { allocatePort } from './harness.ts';
import { RELOAD_PROBE_MS } from './staleness.ts';

/**
 * Two instances over one workspace, and only one of them is ever told.
 *
 * The topology this exists for is Cloud Run's: `--max-instances` defaults to
 * four, a `POST /reload` reaches one of them, and `epoch` is process-local with
 * nothing comparing it across processes. ADR-029 names that as its own gap and
 * offered the error path as what closes it — which works for a tool name that
 * appeared and cannot fire for a member, a grant or a policy, because none of
 * those moves a tool name.
 *
 * So every assertion here is made against the instance that received **no**
 * notify. Both are started over one `LANES_LINK_HOME`, which gives each its own
 * `openReconciled`, its own `Generations` and `epoch`, its own `OAuthStore`, and
 * its own member resolver with its own view — the workspace being the only
 * thing they share, exactly as on a deployed target.
 *
 * What this does not reproduce is OS-level process isolation: both live in one
 * Bun process and share a module realm. Nothing in the design depends on that,
 * and the rehearsal against a real target is what covers it.
 *
 * **The edits are config writes rather than CLI calls**, deliberately. What is
 * under test is whether a second instance converges on a declared config it was
 * not told about, and the declared config is what the resolver reads — so a
 * write is the honest input. That each command *publishes* its edit is a
 * different property, pinned per function by the sweep in `cli/publish.test.ts`,
 * and driving these through the commands would make every row depend on a
 * Lanes session the member commands check for.
 *
 * ## What this does not prove, said plainly
 *
 * It uses a static `llk_` token, and **that credential already resolved
 * membership per request before any of this work**. So this row would have
 * passed on `develop`, and it is not a test of the fix. What it is a test of is
 * the two-instance claim on a real socket: two `Generations`, two member
 * resolvers, one workspace, no notify to either, and both agreeing within the
 * window. Nothing before this asserted that.
 *
 * The credential that *was* frozen is a browser session, and reaching one needs
 * the authorization flow driven — which needs the federation stub, so it lives
 * in `oauth.test.ts` where that stub is. The per-request and revocation cases
 * for it are there and in `auth/remote.test.ts`.
 *
 * Still outstanding, and neither is pretended at here: the grant and policy rows
 * converging through the digest on a second instance, and anything at all
 * against a real deployed target.
 */

const SUBJECT = 'lanes:convergetest1';
const homes: string[] = [];
const running: RunningEndpoint[] = [];

afterAll(async () => {
  for (const endpoint of running) await endpoint.stop().catch(() => {});
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

/** Run something that writes to stdout, and keep what it wrote out of the reporter. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  try {
    (process.stdout as unknown as { write: () => boolean }).write = (): boolean => true;
    return await run();
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
}

/** The same, but handing back what was written: these commands report rather than return. */
async function capture(run: () => Promise<void>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  try {
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (
      chunk: unknown,
    ): boolean => {
      out += String(chunk);
      return true;
    };
    await run();
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
  return out;
}

/** A workspace holding one profile, a static token, and that token's subject as a member. */
async function workspace(): Promise<{ home: string; token: string }> {
  const home = await mkdtemp(join(tmpdir(), 'lanes-converge-'));
  homes.push(home);
  process.env['LANES_LINK_HOME'] = home;

  await quietly(() =>
    profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true }),
  );

  const issue = { target: 'local', quiet: true, subject: SUBJECT };
  await quietly(() => tokenIssue(issue));
  const token = (await capture(() => tokenShow({ ...issue, raw: true }))).trim();

  await members(home, 'personal', [SUBJECT]);
  return { home, token };
}

/** Rewrite a profile's `members:` block, which is what the resolver reads. */
async function members(home: string, profile: string, subjects: readonly string[]): Promise<void> {
  const path = join(home, layout.profileConfig(profile));
  const text = await readFile(path, 'utf8');
  const block =
    subjects.length === 0
      ? 'members: []\n'
      : `members:\n${subjects.map((s) => `  - { subject: ${s}, role: owner }\n`).join('')}`;

  // Replaces the block wherever it sits, and asserts it was there: a regex that
  // silently matched nothing would make every row below pass by not changing
  // anything.
  const next = text.replace(/members:(\s*\[\]|\n(\s+-.*\n)+)/, block);
  expect(next).not.toBe(text);
  await writeFile(path, next);
}

/** What this instance tells this token it may reach. */
async function reach(endpoint: RunningEndpoint, token: string): Promise<string[]> {
  const response = await fetch(`${endpoint.url.replace(/\/mcp$/, '')}/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { profiles?: string[] };
  return [...(body.profiles ?? [])].sort();
}

describe('an instance nobody notified', () => {
  test('converges on a member added and a member removed', async () => {
    const { home, token } = await workspace();
    let clock = 1_000_000;
    const flags = { target: 'local', quiet: true, profile: await primaryProfile({ target: 'local' }) };

    // Two instances, two ports, one workspace. Neither is sent a `/reload`
    // anywhere in this test — there is no notify at all, which is the point.
    const a = await startEndpoint({ flags, port: allocatePort(), host: '127.0.0.1', clock: () => clock });
    running.push(a);
    const b = await startEndpoint({ flags, port: allocatePort(), host: '127.0.0.1', clock: () => clock });
    running.push(b);

    expect(await reach(b, token)).toEqual(['personal']);

    // Removed. This is the direction that matters: a revocation landing later
    // than a grant is the security property failing.
    await members(home, 'personal', []);

    // **A real wait, not the injected clock**, and the reason is worth knowing.
    // `BearerAuthenticator` is built inside `openRuntime` with a resolver of its
    // own, reading `Date.now`, because `runtime/open.ts` sits one line under the
    // size budget and had no room to take a clock. The injected one reaches the
    // resolver `endpoint.ts` holds — the gate, the key link, and the digest the
    // staleness guard watches — and a static `llk_` token resolves at the first
    // link in the chain and never gets that far. So this row pays the window it
    // actually has. Five seconds of a test suite buys the one assertion a unit
    // test cannot make: a real socket, a real credential, and an instance that
    // was told nothing.
    await Bun.sleep(MEMBERS_TTL_MS + 400);

    expect(await reach(b, token)).toEqual([]);
    // And on the other instance, by the same mechanism rather than by a notify:
    // neither of them was sent one.
    expect(await reach(a, token)).toEqual([]);
  }, 60_000);
});
