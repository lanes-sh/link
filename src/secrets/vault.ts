import {
  blobDocumentIO,
  envOnlyKeySource,
  fileDocumentIO,
  fileKeySource,
  secretDocumentIO,
  generateKey,
  open,
  seal,
  type DocumentIO,
  type KeySource,
} from './document.ts';
import type { BlobStore } from '#stores/blobs';

/**
 * The **vault** store — the owner's own passwords and API keys.
 *
 * Its sibling is `./system.ts`, and the difference between them is the whole
 * point of both: system credentials authorise Lanes Link itself and are
 * unreachable from MCP; vault items belong to the owner and an agent may be
 * granted one, by name, under policy.
 *
 * They share this component, the document format in `./document.ts`, and the
 * adapters. They share **no key, no document, and no environment variable** —
 * `LANES_LINK_VAULT_KEY` against `LANES_LINK_CREDENTIAL_KEY`. One master secret
 * reused across purposes turns any single compromise into a total one, which is
 * why the merge stopped where it did: two implementations of one format was
 * duplication worth removing, two keys is the security model.
 *
 * The shapes differ too, and honestly so. A system credential is a ref and a
 * string. A vault item carries a description and belongs to a connection,
 * because each one becomes its own `vault.get.<id>` capability — which is what
 * makes per-item policy expressible without teaching the policy engine about
 * arguments (ADR-012 §3).
 */

const MAGIC = 'lanes-link-vault';
const DEFAULT_BLOB_KEY = 'vault.enc';

/**
 * The environment variable the key arrives in, and where the sealed document
 * sits when the target keeps it in its credential store.
 *
 * Exported because a deploy has to wire both: it mints the key into the store
 * and tells the platform to mount it under this name. Spelling either of them a
 * second time in `deployments/` is how they drift, and the failure that causes
 * is a revision whose vault reads fail with the key sitting right there.
 */
export const VAULT_KEY_ENV = 'LANES_LINK_VAULT_KEY';
export const DEFAULT_SECRET_REF = 'vault/document';

/**
 * Where the key itself lives, for a target whose credential store can hold it.
 *
 * Beside the document rather than somewhere else, which reads wrong and is not:
 * ADR-022 put the ciphertext in Secret Manager *because* the key already came
 * from there, and a key the deploy cannot reach is one an operator has to carry
 * by hand forever. What keeps them apart is that this one is mounted as an
 * environment variable and the document is not — an attacker holding the
 * document alone still holds ciphertext.
 */
export const VAULT_KEY_REF = 'vault/key';

const KEY_ENV = VAULT_KEY_ENV;

/** Item ids become part of a capability name, so they are held to its grammar. */
export const VAULT_ITEM_ID = /^[a-z0-9][a-z0-9_]*$/;

export interface VaultItem {
  readonly id: string;
  readonly value: string;
  readonly description?: string;
  readonly updatedAt: string;
}

/**
 * Storage for vault items, scoped by connection.
 *
 * `ids` returns names only — there is no operation that enumerates values,
 * which is the one property this and the system store genuinely share.
 */
export interface VaultStore {
  get(connectionId: string, id: string): Promise<VaultItem | null>;
  put(connectionId: string, item: Omit<VaultItem, 'updatedAt'>): Promise<void>;
  delete(connectionId: string, id: string): Promise<boolean>;
  /** Every `<connection>/<item>` pair held, so the runtime can register reads. */
  ids(): Promise<ReadonlyArray<{ connectionId: string; id: string; description?: string }>>;
}

type Entries = Record<string, { value: string; description?: string; updatedAt: string }>;

export interface FileVaultStoreOptions {
  /** Path to the encrypted file, e.g. `./data/personal/vault.enc`. */
  readonly path: string;
  /**
   * 32-byte key. When omitted, read from `LANES_LINK_VAULT_KEY` (base64), else
   * from a sibling `.key` file created on first use at 0600.
   */
  readonly key?: Uint8Array;
  readonly env?: Record<string, string | undefined>;
}

export function createFileVaultStore(options: FileVaultStoreOptions): VaultStore {
  const keyPath = `${options.path}.key`;
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  return new DocumentVaultStore(
    fileDocumentIO(options.path, keyPath),
    fileKeySource({ keyPath, envVar: KEY_ENV, env, explicit: options.key }),
  );
}

export interface BlobVaultStoreOptions {
  /** Where the document lives. Scope it before passing it in. */
  readonly store: BlobStore;
  /** Object key. One document, so one key. */
  readonly key?: string;
  /** 32-byte key. When omitted, `LANES_LINK_VAULT_KEY` — and nothing else. */
  readonly encryptionKey?: Uint8Array;
  /**
   * Where this store's key comes from, when the environment is not the answer.
   *
   * Set by a host serving more than one workspace from one process: a
   * process-global `LANES_LINK_VAULT_KEY` there is one key over every tenant's
   * vault, so a single leak is total and rotating one workspace's key cannot be
   * expressed. Resolved on first use and cached, unlike `encryptionKey`, which
   * would make a host fetch a key for every store it builds including the ones
   * that never touch the vault.
   */
  readonly keySource?: KeySource;
  readonly env?: Record<string, string | undefined>;
}

/**
 * The vault in blob storage — what a deployed instance uses.
 *
 * The file adapter was unconditional before ADR-014: a deployed instance wrote
 * its vault to a container filesystem, and every item in it was discarded by the
 * next revision without an error to say so.
 */
export function createBlobVaultStore(options: BlobVaultStoreOptions): VaultStore {
  const key = options.key ?? DEFAULT_BLOB_KEY;
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  return new DocumentVaultStore(
    blobDocumentIO(options.store, key),
    options.keySource ??
      envOnlyKeySource({
        envVar: KEY_ENV,
        env,
        explicit: options.encryptionKey,
        label: key,
        remedy: 'lanes link vault key generate',
      }),
  );
}

export interface SecretVaultStoreOptions {
  /** The target's own secret store. */
  readonly store: {
    get(ref: string): Promise<string | null>;
    set(ref: string, value: string): Promise<void>;
  };
  /** Where the document lives. One document, so one ref. */
  readonly ref?: string;
  /** 32-byte key. When omitted, `LANES_LINK_VAULT_KEY` — and nothing else. */
  readonly encryptionKey?: Uint8Array;
  /**
   * Where this store's key comes from, when the environment is not the answer.
   *
   * Set by a host serving more than one workspace from one process: a
   * process-global `LANES_LINK_VAULT_KEY` there is one key over every tenant's
   * vault, so a single leak is total and rotating one workspace's key cannot be
   * expressed. Resolved on first use and cached, unlike `encryptionKey`, which
   * would make a host fetch a key for every store it builds including the ones
   * that never touch the vault.
   */
  readonly keySource?: KeySource;
  readonly env?: Record<string, string | undefined>;
}

/**
 * The vault as a single entry in the secret store — what a deployment uses.
 *
 * This looks like the merge the file above spends three paragraphs forbidding,
 * and it is not. What must never be shared is the **key**, and it is not: the
 * document is sealed under `LANES_LINK_VAULT_KEY` before it gets here, so the
 * secret store holds ciphertext it cannot read. Separate document, separate
 * key, separate environment variable — the three things `./index.ts` names.
 * The backend was never on that list, and the two stores have shared adapters
 * since they were merged.
 *
 * **Why the bucket arrangement it replaces was backwards.** `blob` put the
 * vault in object storage so reading it took two things: bucket access *and*
 * the key. But the key already arrives from Secret Manager via `--set-secrets`,
 * and anyone with Secret Manager read access already holds every OAuth refresh
 * token — the whole of Gmail, Drive, and iCloud. The vault is the smaller
 * asset and it was the one behind the taller fence. See ADR-022.
 *
 * Item *names* stay encrypted because they are inside the document, which is
 * why this is one secret rather than one per item.
 *
 * The cost, stated: a secret store that versions writes gains a version per
 * `vault put`. That is a few cents a month on Secret Manager and `vault put` is
 * a rare human action, so nothing prunes them — a prune would need
 * `secretmanager.versions.destroy`, which is deliberately not granted to the
 * identity a deployment runs as.
 */
export function createSecretVaultStore(options: SecretVaultStoreOptions): VaultStore {
  const ref = options.ref ?? DEFAULT_SECRET_REF;
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  return new DocumentVaultStore(
    secretDocumentIO(options.store, ref),
    options.keySource ??
      envOnlyKeySource({
        envVar: KEY_ENV,
        env,
        explicit: options.encryptionKey,
        label: ref,
        remedy: 'lanes link vault key generate',
      }),
  );
}

class DocumentVaultStore implements VaultStore {
  readonly #io: DocumentIO;
  readonly #keySource: KeySource;
  #key: Uint8Array | undefined;
  #cache: Entries | undefined;

  constructor(io: DocumentIO, keySource: KeySource) {
    this.#io = io;
    this.#keySource = keySource;
  }

  async get(connectionId: string, id: string): Promise<VaultItem | null> {
    const entry = (await this.#load())[keyFor(connectionId, id)];
    if (!entry) return null;

    return {
      id,
      value: entry.value,
      ...(entry.description ? { description: entry.description } : {}),
      updatedAt: entry.updatedAt,
    };
  }

  async put(connectionId: string, item: Omit<VaultItem, 'updatedAt'>): Promise<void> {
    assertItemId(item.id);
    const entries = { ...(await this.#load()) };

    entries[keyFor(connectionId, item.id)] = {
      value: item.value,
      ...(item.description ? { description: item.description } : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.#save(entries);
  }

  async delete(connectionId: string, id: string): Promise<boolean> {
    const entries = { ...(await this.#load()) };
    const key = keyFor(connectionId, id);
    if (!(key in entries)) return false;

    delete entries[key];
    await this.#save(entries);
    return true;
  }

  async ids(): Promise<ReadonlyArray<{ connectionId: string; id: string; description?: string }>> {
    return listIds(await this.#load());
  }

  async #resolveKey(): Promise<Uint8Array> {
    return (this.#key ??= await this.#keySource());
  }

  async #load(): Promise<Entries> {
    if (this.#cache) return this.#cache;

    const text = await this.#io.read();
    if (text === null) return (this.#cache = {});

    return (this.#cache = open<Entries>(MAGIC, await this.#resolveKey(), text, this.#io, KEY_ENV));
  }

  async #save(entries: Entries): Promise<void> {
    await this.#io.write(seal(MAGIC, await this.#resolveKey(), entries));
    this.#cache = entries;
  }
}

/** An in-memory store, for tests and for a target that persists nothing. */
export function createMemoryVaultStore(seed: Entries = {}): VaultStore {
  const entries: Entries = { ...seed };

  return {
    async get(connectionId, id) {
      const entry = entries[keyFor(connectionId, id)];
      if (!entry) return null;
      return {
        id,
        value: entry.value,
        ...(entry.description ? { description: entry.description } : {}),
        updatedAt: entry.updatedAt,
      };
    },
    async put(connectionId, item) {
      assertItemId(item.id);
      entries[keyFor(connectionId, item.id)] = {
        value: item.value,
        ...(item.description ? { description: item.description } : {}),
        updatedAt: new Date().toISOString(),
      };
    },
    async delete(connectionId, id) {
      const key = keyFor(connectionId, id);
      if (!(key in entries)) return false;
      delete entries[key];
      return true;
    },
    async ids() {
      return listIds(entries);
    },
  };
}

function listIds(
  entries: Entries,
): ReadonlyArray<{ connectionId: string; id: string; description?: string }> {
  return Object.entries(entries)
    .map(([key, entry]) => {
      const slash = key.indexOf('/');
      return {
        connectionId: key.slice(0, slash),
        id: key.slice(slash + 1),
        ...(entry.description ? { description: entry.description } : {}),
      };
    })
    .sort((a, b) => `${a.connectionId}/${a.id}`.localeCompare(`${b.connectionId}/${b.id}`));
}

function keyFor(connectionId: string, id: string): string {
  return `${connectionId}/${id}`;
}

export function assertItemId(id: string): void {
  if (!VAULT_ITEM_ID.test(id)) {
    throw new Error(
      `Vault item id ${JSON.stringify(id)} must be lowercase letters, digits and "_". ` +
        'The id becomes part of the capability name — "vault.get.github_token" — which is what ' +
        'lets policy grant one item without granting the rest (ADR-012).',
    );
  }
}

/** Generate a fresh vault key, distinct from the system store's. */
export const generateVaultKey = generateKey;
