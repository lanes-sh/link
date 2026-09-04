import { scopeNamespace } from '#dispatch';
import { scopeBlobStore, type BlobStore } from '#stores/blobs';
import type { Config } from '#profile';
import type { Runtime } from '../runtime.ts';
import { answered, refused, type Answer, type DataStoreName } from './surface.ts';

/**
 * Which bytes a store name means, for one profile.
 *
 * Built from `scopeNamespace` and `scopeBlobStore` — the two functions
 * `buildProviderContext` uses — rather than from a path spelled out again, for
 * the reason `memoryStore` in `commands/owner/memory.ts` gives: a second
 * spelling is a second directory the day one of them changes.
 *
 * Skills are the exception and are not scoped here at all. They live at
 * `skills.d/<connection>/` rather than under a provider's blob root, so the
 * runtime hands the store over whole — and hands over `undefined` when the
 * profile grants no skills connection, which is a real state rather than an
 * empty one (ADR-050: a surface that is missing was denied on purpose).
 */

/** The provider id each browsable store belongs to. */
const PROVIDER: Record<Exclude<DataStoreName, 'vault'>, string> = {
  memory: 'lanes_memory',
  tasks: 'lanes_tasks',
  assets: 'lanes_assets',
  skills: 'lanes_skills',
  entities: 'lanes_entities',
};

/**
 * The connection this profile grants for a provider, or nothing.
 *
 * Derived from the grants rather than from the workspace's connections, which
 * is the same question `ownerConnection` asks and the same reason: a workspace
 * holding a store this profile does not grant is not a candidate, and offering
 * it would let the dashboard write somewhere the endpoint would refuse to read.
 *
 * Unlike `ownerConnection` this does not refuse an ambiguous profile by
 * throwing. Two connections is a legitimate shape and the caller may name one;
 * absent a name the first grant wins, in declaration order, because a browser
 * has no terminal to be asked at and a listing that fails is worse than one
 * that shows the store the profile lists first.
 */
function connectionFor(config: Config, provider: string): string | null {
  const prefix = `${provider}.`;
  const grant = config.grants.find((one) => one.connection.startsWith(prefix));
  return grant ? grant.connection.slice(prefix.length) : null;
}

export interface ScopedStore {
  readonly store: BlobStore;
  /** `<provider>.<connection>`, for the audit row. */
  readonly connection: string;
  readonly provider: string;
}

/**
 * The store behind one profile's copy of a browsable name.
 *
 * `409` rather than `404` when the profile grants nothing: the store exists and
 * the person asking owns it, so telling them the grant is missing is useful and
 * reveals nothing they did not already have. A missing *profile* is the other
 * answer and is decided before this is called.
 */
export function storeFor(runtime: Runtime, store: DataStoreName): Answer<ScopedStore> {
  if (store === 'vault') {
    return refused(409, 'not_a_blob_store', 'The vault is not read through a blob store.');
  }

  const provider = PROVIDER[store];
  const connection = connectionFor(runtime.config, provider);

  if (connection === null) {
    return refused(
      409,
      'not_granted',
      `This profile grants no ${provider} connection, so there is nothing here to read.`,
    );
  }

  if (store === 'skills') {
    // Handed over whole rather than scoped, because it is not under the
    // provider blob root. `undefined` and "granted but empty" are different
    // facts and only the first one gets here.
    if (!runtime.skills) {
      return refused(
        409,
        'not_granted',
        'This profile grants no skills connection, so there is nothing here to read.',
      );
    }
    return answered({ store: runtime.skills, connection: `${provider}.${connection}`, provider });
  }

  return answered({
    store: scopeBlobStore(runtime.storage, scopeNamespace(provider, connection)),
    connection: `${provider}.${connection}`,
    provider,
  });
}
