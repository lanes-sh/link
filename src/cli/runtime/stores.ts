import { layout } from '#profile';
import type { BlobStore } from '#stores/blobs';
import type { StorageFactory } from '#deployments/target.ts';

/**
 * Where the owner layer's bytes are, for a runtime being assembled.
 *
 * Split from `open.ts` so that file stays inside the size budget, on the seam
 * it already had: `open.ts` decides what a runtime *is* and this decides where
 * one store lives. Both roots are explicit areas rather than derived from
 * `storage.path`, matching `openState` and `openAudit` — a workspace that moves
 * its provider blobs does not move the reserved roots beside them.
 */

/**
 * A store with nothing in it, for a profile that grants no skills connection.
 *
 * Written out rather than imported from `#stores/blobs/testing.ts`: that module
 * exists for tests, and production code reaching into it is how a test double
 * ends up on a real path. Five methods, none of which can fail, is cheaper than
 * the import would be to justify.
 */
export const EMPTY_SKILL_STORE: BlobStore = {
  get: async () => null,
  put: async () => {
    throw new Error('this profile grants no skills connection');
  },
  has: async () => false,
  delete: async () => {},
  list: async () => [],
};

/**
 * Where a connection's skills live, in either workspace.
 *
 * `data/skills.d/<connection>/`, and deployed the same key under the bucket
 * prefix. Going through the store rather than a filesystem path is what gives a
 * deployment skills at all — a path is baked into a container image at build
 * time and an object key is not, so before ADR-014 a deployed instance could
 * only ever serve the skills that existed when its image was built.
 *
 * **Per connection**, which is the third answer this question has had. Policy
 * gating `skills.<name>` was the whole isolation story while the bytes were
 * shared (ADR-012 §1), and it is a weak one: it decides who may *run* a
 * procedure, not who may read that it exists or what it says. ADR-030 made the
 * bytes per profile; ADR-059 made them per connection, so two profiles granting
 * one skills connection share a set and two granting different ones share
 * nothing.
 */
export function skillStore(storage: StorageFactory, connection: string): BlobStore {
  return storage(layout.skills(connection));
}

