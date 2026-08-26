/**
 * The wire, for the two files above it.
 *
 * `github-repo.ts` holds the state — which commit the branch is on, what is in
 * its tree, which blobs have been read — and `github-commit.ts` holds the one
 * operation that assembles several files into a single commit. What is left
 * here is everything neither of them should have to know twice: the host, the
 * headers, base64, path encoding, and what a failure means.
 *
 * `fetch` and no client library, the same argument `gcs.ts` and
 * `gcp-secret-manager.ts` make: a repository holding live refresh tokens does
 * not take on a transitive dependency tree to save some URL building.
 */

/**
 * Declared here rather than imported, for the reason `gcs.ts` gives: this
 * component may not import `#auth`, and `typeof globalThis.fetch` under Bun's
 * types carries a `preconnect` a test double would have to stub.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const API = 'https://api.github.com';

/** Every request declares the version, as GitHub's own documentation does. */
const VERSION = '2022-11-28';

export function githubHeaders(token: string, init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': VERSION,
    ...((init.headers ?? {}) as Record<string, string>),
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return headers;
}

/** Percent-encode each segment, leaving the slashes that address a directory. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function base64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

/**
 * A failure that says what was being attempted and, where GitHub's own message
 * does not, what to do about it.
 *
 * Three are worth naming because they are the three an operator actually hits:
 * a token that has expired or was never granted this repository, the rate
 * limit, and a repository whose name is right and whose visibility is not.
 * GitHub answers the last two of those with a 404 by design — it does not
 * confirm that a repository you cannot see exists — so the message has to offer
 * the causes rather than assert one.
 */
export async function failure(what: string, response: Response): Promise<GithubApiError> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 300);

  if (response.status === 401) {
    return new GithubApiError(
      `GitHub refused the token while trying to ${what} (401). It has expired, been revoked, or ` +
        'was never valid. Generate another and run: lanes link knowledge use github --repo <owner/name>',
      401,
    );
  }

  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0);
    const when = reset > 0 ? new Date(reset * 1000).toISOString() : 'shortly';
    return new GithubApiError(
      `GitHub's rate limit is spent, so this could not ${what}. It resets at ${when}. ` +
        "Keeping memory and skills in a repository makes that limit one of this endpoint's own — " +
        'ADR-041 says so plainly, and it is the cost of the arrangement rather than a fault.',
      403,
    );
  }

  if (response.status === 403 || response.status === 404) {
    return new GithubApiError(
      `GitHub would not let this token ${what} (${response.status}). The usual causes are a token ` +
        'that was not granted this repository, a fine-grained token still waiting on an ' +
        `organisation owner's approval, or Contents permission set to read rather than write. ${detail}`,
      response.status,
    );
  }

  return new GithubApiError(
    `GitHub failed to ${what} (${response.status}). ${detail}`,
    response.status,
  );
}
