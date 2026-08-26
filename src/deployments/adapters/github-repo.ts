import {
  API,
  GithubApiError,
  base64,
  encodePath,
  failure,
  githubHeaders,
  type FetchLike,
} from './github-api.ts';

/**
 * A GitHub repository, as something a `BlobStore` can be built on.
 *
 * This file knows GitHub — how a branch is read conditionally, what a tree
 * looks like, how a write is a commit. `github.ts` knows `BlobStore`, and
 * reaches all of it through here.
 *
 * **One of these per target, shared by every store built on it.** Memory and
 * skills are two roots in one repository, so they share a head, a tree, and a
 * blob cache — which means the endpoint's two-second skill poll also keeps
 * memory's view current, at no additional cost. Two clients would each poll,
 * each cache, and could disagree about which commit is current.
 */

/**
 * How long a validated head is trusted before the next read re-checks it.
 *
 * Not a cache of content: blobs are content-addressed and a sha never means
 * different bytes, so those are held for the life of the process without a
 * freshness question. This bounds one thing only — how long we go on believing
 * the branch still points where it did.
 *
 * Two seconds because that is already the staleness this system accepts.
 * `Generation.SKILL_POLL_MS` is 2,000ms, so a skill added elsewhere is invisible
 * to a running endpoint for up to two seconds wherever it is stored. Matching it
 * means a repository is no staler than the filesystem was.
 *
 * The check is a conditional request and GitHub answers 304, which **does not
 * count against the rate limit** — so what this bounds is round trips, not
 * quota. Zero validates on every read.
 */
const DEFAULT_FRESHNESS_MS = 2_000;

export interface GithubRepositoryOptions {
  /** `owner/name`. */
  readonly repo: string;
  readonly token: string;
  /** Defaults to the repository's own default branch, resolved on first use. */
  readonly branch?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly now?: (() => number) | undefined;
  readonly freshnessMs?: number | undefined;
}

/** One file in the tree, as a listing needs it. */
export interface RepositoryEntry {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

/** What a repository looks like to somebody deciding whether to store here. */
export interface RepositoryFacts {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly canPush: boolean;
  readonly empty: boolean;
}

export interface Head {
  readonly commit: string;
  readonly committedAt: Date;
}

export class GithubRepository {
  readonly repo: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #freshnessMs: number;
  #branch: string | undefined;

  /** The branch tip, plus what GitHub gave us to re-ask about it cheaply. */
  #head: Head | null = null;
  #headEtag: string | undefined;
  #headCheckedAt = 0;
  #inFlight: Promise<Head | null> | undefined;

  /** Keyed by the commit sha it was read at, so a stale one is never used. */
  #tree: { commit: string; entries: Map<string, RepositoryEntry> } | undefined;

  /** Content-addressed, so this needs no expiry. */
  readonly #blobs = new Map<string, Uint8Array>();

  constructor(options: GithubRepositoryOptions) {
    this.repo = options.repo;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.#branch = options.branch;
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(`${API}${path}`, { ...init, headers: githubHeaders(this.#token, init) });
  }

  async json<T>(path: string, init: RequestInit = {}, what = path): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await failure(what, response);
    return (await response.json()) as T;
  }

  /** The account the token belongs to. */
  async viewer(): Promise<string> {
    return (await this.json<{ login: string }>('/user', {}, 'identify the token')).login;
  }

  /** What this token can see and do here — the probe `knowledge use` runs. */
  async facts(): Promise<RepositoryFacts> {
    const repository = await this.#repository();
    this.#branch ??= repository.default_branch;

    return {
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
      canPush: repository.permissions?.push === true,
      empty: (await this.head(true)) === null,
    };
  }

  async branch(): Promise<string> {
    this.#branch ??= (await this.#repository()).default_branch;
    return this.#branch;
  }

  #repository(): Promise<{
    full_name: string;
    private: boolean;
    default_branch: string;
    permissions?: { push?: boolean };
  }> {
    return this.json(`/repos/${this.repo}`, {}, `read ${this.repo}`);
  }

  /**
   * The branch tip, or null when the branch has no commits yet.
   *
   * Null is an ordinary answer rather than an error: a repository created for
   * this and not yet written to has no commits, which is exactly the state the
   * first `lanes link knowledge use github` finds. Everything downstream reads
   * it as "empty".
   *
   * Concurrent callers share one request. `allEntries` reads sixteen entries at
   * a time and each of them asks; without this, one search would open sixteen
   * connections to re-learn the same sha.
   */
  async head(force = false): Promise<Head | null> {
    if (!force && this.#head && this.#now() - this.#headCheckedAt < this.#freshnessMs) {
      return this.#head;
    }
    this.#inFlight ??= this.#readHead().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #readHead(): Promise<Head | null> {
    const branch = await this.branch();
    const response = await this.request(
      `/repos/${this.repo}/branches/${encodeURIComponent(branch)}`,
      this.#headEtag ? { headers: { 'if-none-match': this.#headEtag } } : {},
    );

    this.#headCheckedAt = this.#now();

    // 304 is the answer this exists for: unchanged, free of rate limit, and the
    // tree cached below is still current because it is keyed by the same sha.
    if (response.status === 304) return this.#head;

    if (response.status === 404) {
      this.#head = null;
      this.#headEtag = undefined;
      return null;
    }
    if (!response.ok) throw await failure(`read branch "${branch}" of ${this.repo}`, response);

    const body = (await response.json()) as {
      commit: { sha: string; commit?: { committer?: { date?: string } } };
    };
    this.#headEtag = response.headers.get('etag') ?? undefined;
    this.#head = {
      commit: body.commit.sha,
      committedAt: new Date(body.commit.commit?.committer?.date ?? 0),
    };
    return this.#head;
  }

  /**
   * Every blob in the branch, by path.
   *
   * Keyed by the commit it was read at, so an unchanged head reuses it and a
   * moved one refetches. One request per commit rather than one per listing is
   * the whole reason `list` is affordable here.
   */
  async entries(): Promise<{ entries: Map<string, RepositoryEntry>; committedAt: Date }> {
    const head = await this.head();
    if (head === null) return { entries: new Map(), committedAt: new Date(0) };

    if (this.#tree?.commit !== head.commit) {
      const body = await this.json<{
        tree: Array<{ path: string; type: string; sha: string; size?: number }>;
        truncated?: boolean;
      }>(`/repos/${this.repo}/git/trees/${head.commit}?recursive=1`, {}, `list ${this.repo}`);

      // Refused rather than served short. GitHub truncates a recursive tree
      // past roughly 100,000 entries, and a listing missing an arbitrary tail
      // reads as "those entries do not exist" — which for memory is a search
      // that quietly stops finding things.
      if (body.truncated === true) {
        throw new GithubApiError(
          `${this.repo} is too large to list in one request — GitHub truncated the tree. Keep ` +
            'memory and skills in a repository of their own, or under a "path" prefix in a smaller one.',
          200,
        );
      }

      const entries = new Map<string, RepositoryEntry>();
      for (const item of body.tree) {
        if (item.type !== 'blob') continue;
        entries.set(item.path, { path: item.path, sha: item.sha, size: item.size ?? 0 });
      }
      this.#tree = { commit: head.commit, entries };
    }

    return { entries: this.#tree.entries, committedAt: head.committedAt };
  }

  /** One blob's bytes. Cached by sha, which is what a sha is for. */
  async blob(sha: string): Promise<Uint8Array> {
    const cached = this.#blobs.get(sha);
    if (cached) return cached;

    const response = await this.request(`/repos/${this.repo}/git/blobs/${sha}`, {
      headers: { accept: 'application/vnd.github.raw' },
    });
    if (!response.ok) throw await failure(`read blob ${sha} of ${this.repo}`, response);

    const bytes = new Uint8Array(await response.arrayBuffer());
    this.#blobs.set(sha, bytes);
    return bytes;
  }

  /**
   * Create or replace one file, as one commit.
   *
   * The Contents API refuses a write whose `sha` is not the one currently
   * stored, which is how two writers on one branch are kept from silently
   * overwriting each other. One retry against a re-read sha covers the ordinary
   * race — a local command and a deployed endpoint touching the same entry —
   * and a second conflict is a real fight, worth reporting rather than looping on.
   */
  async writeFile(path: string, data: Uint8Array, message: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.shaOf(path, attempt > 0);
      const response = await this.request(`/repos/${this.repo}/contents/${encodePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: base64(data),
          branch: await this.branch(),
          ...(current ? { sha: current } : {}),
        }),
      });

      // 422 is what GitHub answers when a `sha` is required and was not sent —
      // the same staleness as a 409, reached from the other direction.
      if (response.status === 409 || response.status === 422) continue;
      if (!response.ok) throw await failure(`write "${path}" to ${this.repo}`, response);

      this.absorb(await response.json(), path, data.byteLength);
      return;
    }

    throw new GithubApiError(
      `"${path}" in ${this.repo} changed while it was being written, twice. Something else is ` +
        'writing this branch — check for a second endpoint on the same repository.',
      409,
    );
  }

  /** Remove one file. False when there was nothing to remove. */
  async deleteFile(path: string, message: string): Promise<boolean> {
    const sha = await this.shaOf(path, false);
    if (!sha) return false;

    const response = await this.request(`/repos/${this.repo}/contents/${encodePath(path)}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, sha, branch: await this.branch() }),
    });

    // Gone already, or gone since we looked: absence is what the caller wanted.
    if (response.status === 404 || response.status === 409) return false;
    if (!response.ok) throw await failure(`delete "${path}" from ${this.repo}`, response);

    this.absorb(await response.json(), path, null);
    return true;
  }

  /** Forget the head and the tree. Blobs stay: a sha is still that content. */
  invalidate(): void {
    this.#head = null;
    this.#headEtag = undefined;
    this.#headCheckedAt = 0;
    this.#tree = undefined;
  }

  /** The blob sha a path currently has, or undefined when it has none. */
  async shaOf(path: string, force: boolean): Promise<string | undefined> {
    if (force) this.invalidate();
    return (await this.entries()).entries.get(path)?.sha;
  }

  /**
   * Fold a Contents API response back into the cache.
   *
   * It carries both new shas — the commit's and the file's — so the next read
   * needs no round trip to learn what the write just did. A response that is
   * not the documented shape drops the cache instead of being guessed at; the
   * cost of being wrong there is one refetch.
   */
  absorb(body: unknown, path: string, size: number | null): void {
    const response = body as {
      commit?: { sha?: string; committer?: { date?: string } };
      content?: { sha?: string; size?: number };
    };
    const commit = response.commit?.sha;
    if (!commit || !this.#tree) {
      this.invalidate();
      return;
    }

    const entries = new Map(this.#tree.entries);
    if (size === null || !response.content?.sha) entries.delete(path);
    else entries.set(path, { path, sha: response.content.sha, size: response.content.size ?? size });

    this.#tree = { commit, entries };
    this.#head = { commit, committedAt: new Date(response.commit?.committer?.date ?? this.#now()) };
    // The ETag belonged to the previous tip, so the next conditional request
    // must not present it — it would 304 against a branch that has moved.
    this.#headEtag = undefined;
    this.#headCheckedAt = this.#now();
  }
}
