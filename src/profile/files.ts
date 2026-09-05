import { createFilesystemBlobStore } from '#deployments/adapters/filesystem.ts';
import { createGcsBlobStore } from '#deployments/adapters/gcs.ts';
import {
  LANES_SCHEME,
  createLanesBlobStore,
  lanesWorkspaceFrom,
} from '#deployments/adapters/lanes.ts';
import type { BlobStore } from '#stores/blobs';

/**
 * The workspace as a store, so a deployment's config does not have to be baked
 * into its image.
 *
 * `LANES_LINK_HOME` used to be a directory and nothing else, which is why the
 * Dockerfile copies `lanes-link.yaml` and `profiles/` in at build time. Its own
 * comment records the trade and its expiry: *"the image **is** the config, so a
 * revision fully describes what it serves and rollback is a revision switch.
 * The cost is a rebuild per config change, which is the tradeoff docs/detailed/init.md
 * accepts until it becomes annoying."*
 *
 * It became annoying. A policy change should not be a Docker build, and because
 * those paths are gitignored the image cannot be built from a clean checkout at
 * all — which is what stops there ever being one image that serves any
 * workspace.
 *
 * So the root may be a `gs://` URL, and everything that reads config goes
 * through a `BlobStore` rather than through `Bun.file`. There is no bootstrap
 * problem: opening a GCS store needs only the URL and whatever identity is
 * already present, and config carries secret *references* rather than values
 * (`./secret-detection.ts` enforces that), so nothing has to be decrypted
 * before the config that says how to decrypt things can be read.
 *
 * See ADR-023 for what this gives up — a Cloud Run revision no longer fully
 * describes what it serves — and how the guarantee it kept is kept.
 */

const GCS_SCHEME = 'gs://';

/**
 * Where a managed workspace is read from, when nothing overrides it.
 *
 * Spelled here rather than imported from `#auth/lanes/login.ts`, which holds
 * the same default: `profile` may not import `auth`. The override is the same
 * variable both sides read, so a stage deployment points both at one place.
 */
const DEFAULT_API_URL = 'https://api.lanes.sh';

/**
 * Whether a workspace root is somewhere other than this filesystem.
 *
 * Every caller is really asking "may I treat this as a path". Two schemes
 * answer no: a bucket the operator owns, and a workspace Lanes hosts. Getting a
 * managed root wrong here does not fail loudly — `join` would produce a
 * directory named `lanes:` beside the process's working directory, and the
 * config would read as absent rather than as unreachable.
 */
export function isRemoteWorkspace(root: string): boolean {
  return root.startsWith(GCS_SCHEME) || root.startsWith(LANES_SCHEME);
}

/**
 * The workspace's files.
 *
 * Rooted at the workspace, so every caller addresses `lanes-link.yaml` and
 * `profiles/<name>.yaml` by the same relative key whichever backing it has.
 */
export function workspaceFiles(root: string): BlobStore {
  if (!isRemoteWorkspace(root)) return createFilesystemBlobStore({ root });

  // A managed workspace is addressed through the API, which already knows who
  // is calling and which workspaces they belong to. It takes no credential
  // here: the process registers one (ADR: a managed workspace is a workspace),
  // exactly as a `gs://` root takes none and resolves Application Default
  // Credentials from the environment.
  if (root.startsWith(LANES_SCHEME)) {
    return createLanesBlobStore({
      apiUrl: process.env['LANES_API_URL'] ?? DEFAULT_API_URL,
      workspace: lanesWorkspaceFrom(root),
    });
  }

  const withoutScheme = root.slice(GCS_SCHEME.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1);

  if (bucket.length === 0) {
    throw new Error(`LANES_LINK_HOME is "${root}", which names no bucket. Expected gs://<bucket>[/prefix].`);
  }
  return createGcsBlobStore({ bucket, ...(prefix ? { prefix } : {}) });
}

/** Read a UTF-8 document from the workspace, or null when it is not there. */
export async function readWorkspaceFile(files: BlobStore, key: string): Promise<string | null> {
  const bytes = await files.get(key);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export async function writeWorkspaceFile(
  files: BlobStore,
  key: string,
  text: string,
): Promise<void> {
  await files.put(key, new TextEncoder().encode(text), { contentType: 'application/yaml' });
}
