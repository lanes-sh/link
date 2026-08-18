/**
 * Runtime state — what *is*, as against what should be.
 *
 * The split of responsibilities matters and is easy to erode:
 *
 *   config file      what exists (declared, diffable, source of truth)
 *   credential store credential values
 *   state (here)     connection status, token expiry, cursors, provider state
 *   audit log        what happened — objects in the blob store, see `#audit`
 *
 * Nothing here is a source of truth for what *should* exist. All of it can be
 * deleted and rebuilt: reconcile restores the connection rows from the config
 * file, a discovery cache re-discovers, and a logged-out connector authorises
 * again. Keep it that way — the deployed target scales to zero, so
 * administering it by connecting to a database is not a workable model.
 *
 * **There is no database.** Every access below is a point read or write on one
 * key, plus one prefix listing; nothing joins, aggregates, orders, or searches.
 * That was true when this was four SQL tables too — the tables were carrying a
 * query engine nothing queried. It is one object per key in the `BlobStore` the
 * target already opened, which means the local and deployed paths are the same
 * code and the deployed target needs no second service. ADR-020 has the
 * reasoning for the log; this is the same argument applied to the rest.
 */

import type { BlobStore } from '../blobs/index.ts';
import { keyFromEntry, namespacePrefix, objectKey } from './keys.ts';

export type ConnectionStatus =
  | 'active'
  /** Declared, but its credential is missing or rejected. Does not block startup. */
  | 'unauthorized'
  /** No longer declared in config. Never deleted, so audit history stays meaningful. */
  | 'disabled';

export interface ConnectionRecord {
  readonly provider: string;
  readonly id: string;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  readonly credentialExpiresAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `provider.id`, e.g. `gmail.main`. The addressing form used everywhere. */
export function connectionKey(provider: string, id: string): string {
  return `${provider}.${id}`;
}

export interface ConnectionRepository {
  upsert(record: Omit<ConnectionRecord, 'createdAt' | 'updatedAt'>): Promise<ConnectionRecord>;
  get(provider: string, id: string): Promise<ConnectionRecord | null>;
  list(): Promise<ConnectionRecord[]>;
  setStatus(provider: string, id: string, status: ConnectionStatus): Promise<void>;
}

/**
 * Namespaced key-value, scoped by core to `<provider>/<connection>` before a
 * provider ever sees it. A provider cannot read another provider's state, and
 * cannot read another connection's state within its own provider.
 */
export interface KeyValueStore {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
  clearNamespace(namespace: string): Promise<void>;
}

/** Sync cursors for providers that page through upstream data incrementally. */
export interface CursorRepository {
  get(namespace: string): Promise<string | null>;
  set(namespace: string, cursor: string): Promise<void>;
}

export interface RuntimeState {
  readonly connections: ConnectionRepository;
  /**
   * Namespaced key-value. Named `kv` rather than `state` because the whole of
   * this is state — a member called `state` on a thing called `RuntimeState`
   * reads as the whole rather than the part, which is what it was doing when
   * the type was still called `RuntimeState`.
   */
  readonly kv: KeyValueStore;
  readonly cursors: CursorRepository;
}

/**
 * Reserved namespaces, carrying a dot so a provider cannot collide with one.
 *
 * A provider's state is namespaced `<provider>/<connection>` and a provider id
 * is `[a-z][a-z0-9_]*`, so a dot is a character no provider namespace can
 * contain. The same rule keeps `audit.log` and `state.kv` out of reach in
 * `#profile`'s layout.
 */
const CONNECTIONS = 'connections.v1';
const CURSORS = 'cursors.v1';

export function createRuntimeState(
  blobs: BlobStore,
  now: () => Date = () => new Date(),
): RuntimeState {
  const kv = createKeyValue(blobs);

  const readConnection = async (provider: string, id: string): Promise<ConnectionRecord | null> =>
    decodeConnection(await kv.get(CONNECTIONS, connectionKey(provider, id)));

  const connections: ConnectionRepository = {
    async upsert(record) {
      const existing = await readConnection(record.provider, record.id);
      const stored: ConnectionRecord = {
        ...record,
        // Preserved across updates: when a connection was first seen is a fact
        // about the connection, not about the last time reconcile ran.
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      };
      await kv.set(CONNECTIONS, connectionKey(record.provider, record.id), encodeConnection(stored));
      return stored;
    },

    get: readConnection,

    async list() {
      const records: ConnectionRecord[] = [];
      for (const key of await kv.keys(CONNECTIONS)) {
        const record = decodeConnection(await kv.get(CONNECTIONS, key));
        if (record) records.push(record);
      }
      return records.sort(
        (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
      );
    },

    async setStatus(provider, id, status) {
      const existing = await readConnection(provider, id);
      if (!existing) return;
      await kv.set(
        CONNECTIONS,
        connectionKey(provider, id),
        encodeConnection({ ...existing, status, updatedAt: now() }),
      );
    },
  };

  const cursors: CursorRepository = {
    get: (namespace) => kv.get(CURSORS, namespace),
    set: (namespace, cursor) => kv.set(CURSORS, namespace, cursor),
  };

  return { connections, kv, cursors };
}

/**
 * One object per key.
 *
 * Per key rather than one document per namespace, so there is no
 * read-modify-write anywhere: two writers touching different keys never
 * contend, and a torn write can lose at most the one value being written.
 */
export function createKeyValue(blobs: BlobStore): KeyValueStore {
  return {
    async get(namespace, key) {
      const bytes = await blobs.get(objectKey(namespace, key));
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },

    async set(namespace, key, value) {
      await blobs.put(objectKey(namespace, key), new TextEncoder().encode(value), {
        contentType: 'application/json',
      });
    },

    async delete(namespace, key) {
      await blobs.delete(objectKey(namespace, key));
    },

    async keys(namespace) {
      const prefix = namespacePrefix(namespace);
      const found: string[] = [];
      for (const entry of await blobs.list(prefix)) {
        const key = keyFromEntry(prefix, entry.key);
        if (key !== null) found.push(key);
      }
      return found.sort();
    },

    async clearNamespace(namespace) {
      const prefix = namespacePrefix(namespace);
      for (const entry of await blobs.list(prefix)) {
        // Direct children only, matching `keys`. A nested namespace is a
        // different namespace and clearing one must not empty the other.
        if (keyFromEntry(prefix, entry.key) === null) continue;
        await blobs.delete(entry.key);
      }
    },
  };
}

interface StoredConnection {
  provider: string;
  id: string;
  displayName: string;
  status: string;
  credentialExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

function encodeConnection(record: ConnectionRecord): string {
  const stored: StoredConnection = {
    provider: record.provider,
    id: record.id,
    displayName: record.displayName,
    status: record.status,
    ...(record.credentialExpiresAt
      ? { credentialExpiresAt: record.credentialExpiresAt.toISOString() }
      : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
  return JSON.stringify(stored);
}

function decodeConnection(raw: string | null): ConnectionRecord | null {
  if (raw === null) return null;
  try {
    const stored = JSON.parse(raw) as StoredConnection;
    return {
      provider: stored.provider,
      id: stored.id,
      displayName: stored.displayName,
      status: stored.status as ConnectionStatus,
      ...(stored.credentialExpiresAt
        ? { credentialExpiresAt: new Date(stored.credentialExpiresAt) }
        : {}),
      createdAt: new Date(stored.createdAt),
      updatedAt: new Date(stored.updatedAt),
    };
  } catch {
    // A record that will not parse is one nothing can use. Treating it as
    // absent fails closed and lets reconcile rebuild it, which is the whole
    // reason this store is allowed to be lossy.
    return null;
  }
}
