import { version } from './version.ts';

/**
 * Whether a newer release than this one has been published.
 *
 * `version.ts` answers which release is installed, which stopped being the
 * whole question when this started shipping from npm: two machines can now sit
 * a release apart with nothing on either to say so, and the only upgrade
 * affordance in the tree was a `contract` mismatch telling someone to "Upgrade
 * lanes-link" without naming a command.
 *
 * Every function here degrades to `null` or `'unknown'` rather than throwing. A
 * version check is never the reason a command fails — `doctor`, `start`, and
 * `deploy` each print one line from this and must all work on a plane.
 */

/** The npm package this CLI ships as, and the only thing `update` will install. */
export const PACKAGE = '@lanes-sh/link';

/**
 * The dist-tags document, not the packument.
 *
 * `registry.npmjs.org/<name>` carries every version ever published with its
 * full manifest — hundreds of kilobytes to answer a question whose answer is
 * eighteen bytes. This endpoint returns `{"latest":"0.2.0"}` and nothing else.
 */
const DIST_TAGS = `https://registry.npmjs.org/-/package/${encodeURIComponent(PACKAGE)}/dist-tags`;

/**
 * The same budget `endpointHealth` gives its probe.
 *
 * Long enough for a warm connection, short enough that a command which only
 * mentions staleness in passing does not appear to hang on a captive-portal
 * network that accepts the connection and then says nothing.
 */
const PROBE_TIMEOUT_MS = 700;

export type ReleaseState = 'current' | 'stale' | 'ahead' | 'unknown';

export interface Release {
  readonly installed: string;
  /** `null` when the registry could not be reached, or answered something else. */
  readonly latest: string | null;
  readonly state: ReleaseState;
}

/**
 * How the installed version stands against the published one.
 *
 * `'ahead'` is not a mistake: a contributor running from a checkout is usually
 * a version ahead of the registry, and telling them they are behind would be
 * both wrong and the thing they see most often.
 *
 * Pure, and separate from the fetch, so every branch is testable without a
 * network — which is the only way the stale path gets covered at all, given the
 * checkout this is written in is by definition current.
 */
export function releaseState(installed: string, latest: string | null): ReleaseState {
  if (latest === null) return 'unknown';

  try {
    const order = Bun.semver.order(installed, latest);
    return order === 0 ? 'current' : order < 0 ? 'stale' : 'ahead';
  } catch {
    // `Bun.semver.order` throws on anything it cannot parse rather than
    // ordering it arbitrarily. A registry that answers with something other
    // than a version, or a hand-edited `package.json`, is an unknown state and
    // not a reason to claim either answer.
    return 'unknown';
  }
}

/** What the registry calls `latest`, or `null` if it did not say. */
export async function latestRelease(): Promise<string | null> {
  try {
    const response = await fetch(DIST_TAGS, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;

    const body = (await response.json()) as { latest?: unknown };
    return typeof body.latest === 'string' ? body.latest : null;
  } catch {
    return null;
  }
}

/** The installed version, the published one, and how they stand. */
export async function release(): Promise<Release> {
  const installed = version();
  const latest = await latestRelease();

  return { installed, latest, state: releaseState(installed, latest) };
}

/**
 * The one line `doctor`, `start`, and `deploy` print when this install is behind.
 *
 * One string in one place, because three commands saying it three ways is how
 * two of them end up naming a command that has been renamed. `null` for every
 * state but `'stale'`: nothing is worth saying about an install that is current,
 * and an unreachable registry is not news.
 */
export function staleLine(current: Release): string | null {
  if (current.state !== 'stale') return null;

  return `${current.installed} is installed, ${current.latest} is out — run: lanes link update`;
}

/** `staleLine` over a fresh probe, for a caller that has no `Release` in hand. */
export async function staleNudge(): Promise<string | null> {
  return staleLine(await release());
}
