import type { FetchLike } from './github-api.ts';

/**
 * A GitHub repository, in memory, for the adapter's tests.
 *
 * Test-only, behind the `-testing` suffix the blob and state stores already use
 * for the same purpose, so application code does not reach it by habit. It is not
 * a general GitHub simulator: it implements exactly the eight requests
 * `github-repo.ts` and `github-commit.ts` make, and answers anything else with
 * a 501 so an untested code path fails loudly rather than silently.
 *
 * What it does model faithfully, because the adapter's correctness rests on it:
 * blob shas are content hashes (so "same sha, same bytes" is true, which is
 * what makes the blob cache sound), commits snapshot the tree, the branch read
 * answers 304 to a matching `If-None-Match`, and a Contents write with a stale
 * `sha` answers 409.
 */

export interface FakeGithubOptions {
  readonly repo?: string;
  readonly private?: boolean;
  readonly defaultBranch?: string;
  readonly canPush?: boolean;
  /** Start with commits already in place, rather than an empty repository. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface FakeGithub {
  readonly fetch: FetchLike;
  /** Every request, as `METHOD /path`, in order. */
  readonly calls: string[];
  /** The files at the branch tip. */
  files(): Record<string, string>;
  commitCount(): number;
  /** Answer the next matching request with this instead. */
  failNext(match: string, response: Response): void;
  /**
   * Answer every matching request this way, from now on.
   *
   * The shape a token that has expired actually has: not one bad response, but
   * every response, until somebody replaces it. `failNext` models a race;
   * this models a state.
   */
  failEvery(match: string, make: () => Response): void;
  /** Change a file behind the adapter's back, as another writer would. */
  writeBehind(path: string, text: string): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Content-addressed, so the adapter's blob cache is exercised honestly. */
function blobSha(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha1');
  hasher.update(data);
  return hasher.digest('hex');
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function createFakeGithub(options: FakeGithubOptions = {}): FakeGithub {
  const repo = options.repo ?? 'my-org/my-notes';
  const branch = options.defaultBranch ?? 'main';
  const calls: string[] = [];
  const overrides: Array<{ match: string; response: Response }> = [];
  const standing: Array<{ match: string; make: () => Response }> = [];

  /** Path → bytes, at the tip. */
  let files = new Map<string, Uint8Array>();
  /** Commit sha → the tree it points at. Trees are addressed by commit here. */
  const commits = new Map<string, Map<string, Uint8Array>>();
  /** Loose objects created by the Git Data API before a commit references them. */
  const loose = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, Uint8Array>>();
  let head: string | null = null;
  let counter = 0;

  const snapshot = (): string => {
    counter += 1;
    const sha = `commit${counter}`;
    commits.set(sha, new Map(files));
    head = sha;
    return sha;
  };

  if (options.files) {
    for (const [path, text] of Object.entries(options.files)) {
      files.set(path, encoder.encode(text));
    }
    snapshot();
  }

  const treeOf = (sha: string): Map<string, Uint8Array> => commits.get(sha) ?? new Map();

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname;
    calls.push(`${method} ${path}`);

    const override = overrides.findIndex((entry) => `${method} ${path}`.includes(entry.match));
    if (override !== -1) return overrides.splice(override, 1)[0]!.response;

    const always = standing.find((entry) => `${method} ${path}`.includes(entry.match));
    if (always) return always.make();

    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const headers = (init.headers ?? {}) as Record<string, string>;

    if (method === 'GET' && path === `/repos/${repo}`) {
      return json({
        full_name: repo,
        private: options.private ?? true,
        default_branch: branch,
        permissions: { push: options.canPush ?? true },
      });
    }

    if (method === 'GET' && path === '/user') return json({ login: 'an-owner' });

    if (method === 'GET' && path === `/repos/${repo}/branches/${branch}`) {
      if (head === null) return json({ message: 'Branch not found' }, { status: 404 });
      const etag = `"${head}"`;
      if (headers['if-none-match'] === etag) return new Response(null, { status: 304 });

      return json(
        { commit: { sha: head, commit: { committer: { date: '2026-01-02T03:04:05Z' } } } },
        { headers: { etag } },
      );
    }

    if (method === 'GET' && path.startsWith(`/repos/${repo}/git/trees/`)) {
      const sha = path.slice(`/repos/${repo}/git/trees/`.length);
      const tree = commits.has(sha) ? treeOf(sha) : (trees.get(sha) ?? new Map());
      return json({
        sha,
        tree: [...tree].map(([entry, data]) => ({
          path: entry,
          mode: '100644',
          type: 'blob',
          sha: blobSha(data),
          size: data.byteLength,
        })),
        truncated: false,
      });
    }

    if (method === 'GET' && path.startsWith(`/repos/${repo}/git/blobs/`)) {
      const sha = path.slice(`/repos/${repo}/git/blobs/`.length);
      for (const data of [...files.values(), ...loose.values()]) {
        if (blobSha(data) === sha) return new Response(data);
      }
      for (const tree of commits.values()) {
        for (const data of tree.values()) if (blobSha(data) === sha) return new Response(data);
      }
      return json({ message: 'Not Found' }, { status: 404 });
    }

    if (path.startsWith(`/repos/${repo}/contents/`)) {
      const target = decodeURIComponent(path.slice(`/repos/${repo}/contents/`.length));
      const existing = files.get(target);
      const given = body?.['sha'] as string | undefined;

      if (existing && given !== blobSha(existing)) {
        return json({ message: 'does not match' }, { status: 409 });
      }
      if (!existing && given) return json({ message: 'not found' }, { status: 404 });

      if (method === 'PUT') {
        const data = decodeBase64(String(body?.['content'] ?? ''));
        files.set(target, data);
        const sha = snapshot();
        return json({
          content: { sha: blobSha(data), size: data.byteLength },
          commit: { sha, committer: { date: '2026-01-02T03:04:05Z' } },
        });
      }

      if (method === 'DELETE') {
        if (!existing) return json({ message: 'Not Found' }, { status: 404 });
        files.delete(target);
        const sha = snapshot();
        return json({ commit: { sha, committer: { date: '2026-01-02T03:04:05Z' } } });
      }
    }

    if (method === 'POST' && path === `/repos/${repo}/git/blobs`) {
      const data = decodeBase64(String(body?.['content'] ?? ''));
      const sha = blobSha(data);
      loose.set(sha, data);
      return json({ sha });
    }

    if (method === 'POST' && path === `/repos/${repo}/git/trees`) {
      const base = body?.['base_tree'] as string | undefined;
      const tree = new Map(base ? treeOf(base) : []);

      for (const entry of (body?.['tree'] ?? []) as Array<{ path: string; sha: string | null }>) {
        if (entry.sha === null) tree.delete(entry.path);
        else {
          const data = loose.get(entry.sha);
          if (data) tree.set(entry.path, data);
        }
      }

      counter += 1;
      const sha = `tree${counter}`;
      trees.set(sha, tree);
      return json({ sha });
    }

    if (method === 'POST' && path === `/repos/${repo}/git/commits`) {
      counter += 1;
      const sha = `commit${counter}`;
      commits.set(sha, new Map(trees.get(String(body?.['tree'])) ?? new Map()));
      return json({ sha });
    }

    // Creating the first ref, or moving an existing one. Both land the commit.
    if (
      (method === 'POST' && path === `/repos/${repo}/git/refs`) ||
      (method === 'PATCH' && path === `/repos/${repo}/git/refs/heads/${branch}`)
    ) {
      const sha = String(body?.['sha']);
      if (!commits.has(sha)) return json({ message: 'no such commit' }, { status: 422 });
      head = sha;
      files = new Map(treeOf(sha));
      return json({ ref: `refs/heads/${branch}`, object: { sha } });
    }

    return json({ message: `the fake does not implement ${method} ${path}` }, { status: 501 });
  };

  return {
    fetch,
    calls,
    files: () => Object.fromEntries([...files].map(([path, data]) => [path, decoder.decode(data)])),
    commitCount: () => commits.size,
    failNext: (match, response) => overrides.push({ match, response }),
    failEvery: (match, make) => standing.push({ match, make }),
    writeBehind: (path, text) => {
      files.set(path, encoder.encode(text));
      snapshot();
    },
  };
}
