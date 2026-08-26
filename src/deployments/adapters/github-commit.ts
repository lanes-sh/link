import { base64 } from './github-api.ts';
import type { GithubRepository } from './github-repo.ts';

/**
 * Many files, and many deletions, as **one** commit.
 *
 * `writeFile` is one commit per file, which is right for a single write and
 * wrong for a migration: two hundred commits each reading "store memory entry"
 * is not a history anybody opens, and it is two hundred round trips against a
 * limit this endpoint now shares. This goes through the Git Data API instead —
 * blobs, a tree, a commit, then move the ref — which is what `git push` does
 * and produces the same object graph.
 *
 * Its own file because it is the one operation that does not fit the
 * one-request-one-answer shape of everything in `github-repo.ts`, and because
 * it needs none of that file's private state: it works entirely through the
 * repository's public surface, so the split costs nothing.
 *
 * **The empty repository is the ordinary case here, not an edge one.** Somebody
 * following the setup steps creates a repository for this and migrates into it
 * immediately, so there is no parent commit and no base tree, and the ref has
 * to be created rather than moved.
 */

export interface CommitFile {
  readonly path: string;
  readonly data: Uint8Array;
}

/** The new commit sha, or null when there was nothing to commit. */
export async function commitFiles(
  repository: GithubRepository,
  files: readonly CommitFile[],
  deletes: readonly string[],
  message: string,
): Promise<string | null> {
  if (files.length === 0 && deletes.length === 0) return null;

  const branch = await repository.branch();
  // Forced: a migration is the one place where reading a two-second-old head
  // could mean committing against a parent that has already moved.
  const head = await repository.head(true);

  const blobs = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      sha: (
        await repository.json<{ sha: string }>(
          `/repos/${repository.repo}/git/blobs`,
          {
            method: 'POST',
            body: JSON.stringify({ content: base64(file.data), encoding: 'base64' }),
          },
          `upload "${file.path}" to ${repository.repo}`,
        )
      ).sha,
    })),
  );

  const tree = await repository.json<{ sha: string }>(
    `/repos/${repository.repo}/git/trees`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(head ? { base_tree: head.commit } : {}),
        tree: [
          ...blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
          // A null sha is how the Git Data API spells "not in this tree".
          ...deletes.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
        ],
      }),
    },
    `build a tree for ${repository.repo}`,
  );

  const commit = await repository.json<{ sha: string }>(
    `/repos/${repository.repo}/git/commits`,
    {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: head ? [head.commit] : [] }),
    },
    `commit to ${repository.repo}`,
  );

  // Create when the branch has no commits, move when it does. A `PATCH` on a
  // ref that does not exist answers 422, which reads as a permissions problem
  // and is not one.
  await repository.json(
    head
      ? `/repos/${repository.repo}/git/refs/heads/${encodeURIComponent(branch)}`
      : `/repos/${repository.repo}/git/refs`,
    {
      method: head ? 'PATCH' : 'POST',
      body: JSON.stringify(
        head ? { sha: commit.sha } : { ref: `refs/heads/${branch}`, sha: commit.sha },
      ),
    },
    `move "${branch}" in ${repository.repo}`,
  );

  repository.invalidate();
  return commit.sha;
}
