import type { AttachmentBridge } from '#connectivity/mail';
import {
  getStaged,
  newHandle,
  putStaged,
  sweepStaged,
  PROFILE_HANDLE,
  STAGED_TTL_MS,
  type StagedFile,
} from '#connectivity/mail';
import type { GrantConfig } from '#profile';
import { layout } from '#profile';
import type { BlobStore } from '#stores/blobs';
import { scopeBlobStore } from '#stores/blobs';
import { createHash } from 'node:crypto';
import { scopeNamespace } from './context.ts';

/**
 * The two file lookups a connection-scoped store cannot serve.
 *
 * Both cross the `<provider>/<connection>` boundary every other store keeps, so
 * both are built here rather than in a provider: `ProviderContext` promises no
 * way to reach another connection, and the way to keep that promise while still
 * answering "attach the file I just handed you" is for dispatch to bind the two
 * lookups and hand over closures, not stores.
 *
 * What makes the crossing safe is what may pass through it. The profile area
 * only ever receives bytes the *caller* supplied — `data`, `url`, `path` on
 * `lanes_assets.stage` — or bytes the profile already owns, through `asset`. It
 * never receives bytes read out of a third party's account: `get_attachment`
 * keeps minting a connection-scoped `att_` handle, and nothing here promotes
 * one. Change that and the boundary is gone, not narrowed.
 */

const ASSETS = 'lanes_assets';

export interface AttachmentBridgeDeps {
  /** The profile's blob store, as `layout.blobs(profile)` roots it. */
  readonly storage: BlobStore;
  /** This profile's grants, which decide which assets connection is reachable. */
  readonly grants: readonly GrantConfig[];
  /** Whether this caller may run a capability on a connection. Dispatch supplies `evaluate`. */
  readonly allows: (capability: string, connection: string) => boolean;
  readonly now?: () => number;
}

export function createAttachmentBridge(deps: AttachmentBridgeDeps): AttachmentBridge {
  const now = deps.now ?? (() => Date.now());
  const area = scopeBlobStore(deps.storage, layout.attachmentsKey());

  return {
    async stage(input) {
      // Swept here rather than on a timer: there is no scheduler in this
      // process, and staging is the only thing that makes the garbage.
      await sweepStaged(area).catch(() => 0);

      const handle = newHandle(PROFILE_HANDLE);
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const expiresAt = now() + STAGED_TTL_MS;

      await putStaged(area, {
        handle,
        bytes: input.bytes,
        metadata: {
          filename: input.filename,
          content_type: input.contentType,
          sha256,
          expires_at: expiresAt,
        },
      });

      return { handle, sha256, expiresAt };
    },

    staged: (handle: string): Promise<StagedFile | null> => getStaged(area, handle),

    // Resolved on use rather than at build time. Every dispatch would otherwise
    // pay for a policy evaluation and a grant scan that almost no call needs.
    asset: async (name: string): Promise<StagedFile | null> => {
      const store = assetStore(deps);
      const bytes = await store.get(name);
      return bytes ? { bytes, filename: name, contentType: null } : null;
    },
  };
}

function assetStore(deps: AttachmentBridgeDeps): BlobStore {
  const prefix = `${ASSETS}.`;
  // From the grants, not the workspace's connections: the question is which
  // store *this profile* may reach. Same rule as `ownerConnection`.
  const candidates = deps.grants
    .filter((grant) => grant.connection.startsWith(prefix))
    .map((grant) => grant.connection.slice(prefix.length));

  if (candidates.length === 0) {
    throw new Error('This profile keeps no files, so there is no asset to name.');
  }
  // Ordering is not selection. Picking one of two would turn a question for the
  // owner into a silent choice of which store an outgoing file came from.
  if (candidates.length > 1) {
    throw new Error(
      `This profile has ${candidates.length} asset stores (${candidates.join(', ')}), ` +
        `so "asset" does not name one file. Stage the file instead, or store it in one of them.`,
    );
  }

  const id = candidates[0]!;
  // The gate a provider cannot apply for itself. Without it, a caller denied the
  // asset store but allowed a send could read it through an attachment argument.
  if (!deps.allows(`${ASSETS}.get`, `${ASSETS}.${id}`)) {
    throw new Error('This caller is not permitted to read the files this profile keeps.');
  }

  return scopeBlobStore(deps.storage, scopeNamespace(ASSETS, id));
}
