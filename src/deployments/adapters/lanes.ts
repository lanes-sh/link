import { containedKey, type BlobKey, type BlobMetadata, type BlobStore } from '#stores/blobs';

/**
 * A workspace Lanes hosts, addressed over the API.
 *
 * The other remote adapter is `gcs.ts`, and it cannot serve this. A `gs://`
 * root is opened with the caller's own Google credentials, which is exactly
 * right for a bucket in the operator's project and impossible for one in ours:
 * handing a laptop credentials to Lanes' storage would hand it every tenant's
 * bytes, and scoping that down per workspace is an IAM condition per tenant on
 * a bucket nobody outside Lanes should be able to name.
 *
 * So the managed scheme goes through the API, which already knows who is
 * calling and which workspaces they are a member of. The check that a caller
 * may read this workspace happens there, once, beside every other check of the
 * same kind — not here, where it would be a client-side rule a client could
 * simply not apply.
 *
 * **This is the seam that makes managed symmetric with the other two.** The
 * CLI, the control plane and the runtime all read config through `BlobStore`,
 * so a workspace at `lanes://<id>` is administered by the same commands as one
 * in `~/.lanes-link` or a bucket. Nothing above this file knows which it has.
 */

export const LANES_SCHEME = 'lanes://';

/**
 * A `fetch` this adapter can be handed.
 *
 * Narrower than `typeof globalThis.fetch`, which under Bun's types carries a
 * `preconnect` method no test double has any reason to implement. Spelled the
 * same way in `gcs.ts` and `github-api.ts` for the same reason.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Objects per listing page. The API pages; this is what it is asked for. */
const PAGE_SIZE = 1000;

/** How a caller proves who it is. The CLI signs in; the control plane asserts. */
export interface TokenSource {
  token(): Promise<string>;
}

export interface LanesBlobStoreOptions {
  /** Where the API lives, without a trailing slash. */
  readonly apiUrl: string;
  /** Which workspace's files these are. */
  readonly workspace: string;
  /** Omitted, the one the process registered. See `useLanesCredentials`. */
  readonly tokens?: TokenSource;
  readonly fetch?: FetchLike;
}

/**
 * The credential this process presents to the Lanes API, registered once.
 *
 * A slot rather than a parameter, and it is worth saying why, because a mutable
 * module-level value is the kind of thing this repository refuses by default.
 *
 * `workspaceFiles(root)` takes a root and nothing else, at thirty-five call
 * sites, because "give me this workspace's files" genuinely needs nothing else
 * — a `gs://` root is opened with Application Default Credentials, which Google's
 * own client resolves from the environment without anybody threading it
 * through. The credential is a property of the process's identity, not of any
 * one call.
 *
 * This adapter cannot do the same thing the same way: reading the signed-in
 * session means importing `auth`, and `deployments` may not, which is the rule
 * that keeps a storage backend from growing an opinion about who is calling.
 * So the layer that *may* read a session registers one — `src/cli/lanes.ts`
 * after sign-in, the container from its own identity — and the adapter asks for
 * it at call time rather than at construction, so registration order does not
 * matter.
 */
let registered: TokenSource | null = null;

/** Register the process's credential, or clear it with `null`. */
export function useLanesCredentials(tokens: TokenSource | null): void {
  registered = tokens;
}

const registeredTokens: TokenSource = {
  async token() {
    if (registered === null) {
      throw new Error(
        'No credential is registered for a lanes:// workspace, so there is nothing to ' +
          'present to the Lanes API. Run `lanes auth login` if you are at a terminal; a ' +
          'service registers one at startup.',
      );
    }
    return registered.token();
  },
};

/**
 * The workspace named by a `lanes://` root.
 *
 * Kept beside the adapter rather than in `files.ts` so the scheme is parsed and
 * served in one place. `files.ts` decides *which* adapter a root gets; what a
 * root means is this file's.
 */
export function lanesWorkspaceFrom(root: string): string {
  const workspace = root.slice(LANES_SCHEME.length).replace(/\/+$/, '');
  if (workspace.length === 0 || workspace.includes('/')) {
    throw new Error(
      `LANES_LINK_HOME is ${JSON.stringify(root)}, which names no workspace. ` +
        `Expected ${LANES_SCHEME}<workspace-id>.`,
    );
  }
  return workspace;
}

export function createLanesBlobStore(options: LanesBlobStoreOptions): BlobStore {
  const call: FetchLike = options.fetch ?? globalThis.fetch;
  const tokens = options.tokens ?? registeredTokens;
  const base = `${options.apiUrl.replace(/\/+$/, '')}/v1/workspaces/${encodeURIComponent(options.workspace)}/link/files`;

  // Containment is applied here as well as on the server. The server's check is
  // the one that counts — a client rule is one a client can decline to run —
  // but a key that escapes should fail in the caller's own stack trace rather
  // than as a 400 from three components away.
  const objectUrl = (key: BlobKey): string =>
    `${base}/object?key=${encodeURIComponent(containedKey(key))}`;

  const request = async (url: string, init: RequestInit = {}): Promise<Response> =>
    call(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${await tokens.token()}` },
    });

  const failure = async (operation: string, key: string, response: Response): Promise<Error> => {
    const detail = (await response.text().catch(() => '')).slice(0, 400);

    if (response.status === 401 || response.status === 403) {
      return new Error(
        `Lanes refused to ${operation} "${key}" in workspace ${options.workspace} ` +
          `(${response.status}). Either this credential has expired — \`lanes auth login\` ` +
          'mints a new one — or its subject is not a member of that workspace. ' +
          `${detail}`,
      );
    }
    return new Error(
      `Lanes failed to ${operation} "${key}" in workspace ${options.workspace} ` +
        `(${response.status}). ${detail}`,
    );
  };

  return {
    async put(key, data, putOptions) {
      const response = await request(objectUrl(key), {
        method: 'PUT',
        body: data,
        headers: { 'content-type': putOptions?.contentType ?? 'application/octet-stream' },
      });
      if (!response.ok) throw await failure('write', key, response);
    },

    async get(key) {
      const response = await request(objectUrl(key));
      // Absence is a value, not an error — every caller is written against null.
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('read', key, response);
      return new Uint8Array(await response.arrayBuffer());
    },

    async has(key) {
      const response = await request(objectUrl(key), { method: 'HEAD' });
      if (response.status === 404) return false;
      if (!response.ok) throw await failure('stat', key, response);
      return true;
    },

    async delete(key) {
      const response = await request(objectUrl(key), { method: 'DELETE' });
      // Deleting what is not there is not a failure: callers use this to make
      // absence true, and a sweep racing another sweep must not throw.
      if (response.status === 404) return;
      if (!response.ok) throw await failure('delete', key, response);
    },

    async list(prefix) {
      const found: BlobMetadata[] = [];
      let cursor: string | undefined;

      do {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (prefix) query.set('prefix', containedKey(prefix));
        if (cursor) query.set('cursor', cursor);

        const response = await request(`${base}/list?${query}`);
        if (!response.ok) throw await failure('list', prefix ?? '', response);

        const page = (await response.json()) as {
          files?: Array<{
            key: string;
            size?: number;
            contentType?: string;
            modifiedAt?: string;
          }>;
          next?: string;
        };

        for (const file of page.files ?? []) {
          found.push({
            key: file.key,
            size: file.size ?? 0,
            ...(file.contentType ? { contentType: file.contentType } : {}),
            modifiedAt: file.modifiedAt ? new Date(file.modifiedAt) : new Date(0),
          });
        }

        cursor = page.next;
      } while (cursor !== undefined);

      // Sorted here rather than trusted from the API. The contract every other
      // adapter satisfies says listings are sorted, and a store that is sorted
      // only when the server felt like it is not the same interface — the
      // callers that walk a profile's files would differ by backend, which is
      // exactly what `describeBlobStoreContract` exists to prevent.
      return found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    },
  };
}
