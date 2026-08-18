import {
  assertKeyLength,
  blobDocumentIO,
  envOnlyKeySource,
  fileDocumentIO,
  fileKeySource,
  generateKey,
  open,
  seal,
  type DocumentIO,
  type KeySource,
} from './document.ts';
import { assertValidSecretRef, type SecretRef, type SecretStore } from './index.ts';
import type { BlobStore } from '#stores/blobs';

/**
 * The **system** store — what the system holds in order to do its job.
 *
 * OAuth refresh tokens, OAuth client secrets, the profile API token. These
 * authorise the system itself, and they are NEVER reachable from MCP, in any
 * form, for any client. If an agent could read the Gmail refresh token it would
 * simply call Google directly, and the entire policy layer would become
 * decorative.
 *
 * Its sibling is `./vault.ts` — the owner's own passwords and API keys, which an
 * agent may legitimately be granted access to under policy. They share this
 * component, the document format, and the adapters. They share no key, no
 * document, and no path from a `ProviderContext` — see the two tests named in
 * `./index.ts`.
 *
 * WHAT THIS DOES NOT DO, stated because the security model says so rather than
 * implying a guarantee the code does not deliver: encryption at rest protects
 * stored credentials from someone reading the file. It does not protect a
 * credential while a process is using it — the plaintext is in memory whenever
 * a provider makes a call. That limit is inherent.
 */

const MAGIC = 'lanes-link-credentials';
const KEY_ENV = 'LANES_LINK_CREDENTIAL_KEY';
const DEFAULT_BLOB_KEY = 'credentials.enc';

export interface FileSystemSecretsOptions {
  /** Path to the encrypted file, e.g. `./data/personal/credentials.enc`. */
  readonly path: string;
  /**
   * 32-byte key. When omitted, read from `LANES_LINK_CREDENTIAL_KEY` (base64),
   * else from a sibling `.key` file, which is created on first use at 0600.
   */
  readonly key?: Uint8Array;
  readonly env?: Record<string, string | undefined>;
}

export function createFileSecretStore(options: FileSystemSecretsOptions): SecretStore {
  const keyPath = `${options.path}.key`;
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  return new DocumentSecretStore(
    fileDocumentIO(options.path, keyPath),
    fileKeySource({ keyPath, envVar: KEY_ENV, env, explicit: options.key }),
  );
}

export interface BlobSecretsOptions {
  /** Where the document lives. Scope it before passing it in. */
  readonly store: BlobStore;
  readonly key?: string;
  readonly encryptionKey?: Uint8Array;
  readonly env?: Record<string, string | undefined>;
}

export function createBlobSecretStore(options: BlobSecretsOptions): SecretStore {
  const key = options.key ?? DEFAULT_BLOB_KEY;
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  return new DocumentSecretStore(
    blobDocumentIO(options.store, key),
    envOnlyKeySource({
      envVar: KEY_ENV,
      env,
      explicit: options.encryptionKey,
      label: key,
      remedy: 'openssl rand -base64 32',
    }),
  );
}

/**
 * A `SecretStore` over one encrypted document.
 *
 * The whole document is rewritten on every change, which is right for something
 * holding tens of entries and would not be for something holding millions.
 * Per-entry encryption with plaintext keys would be marginally more convenient
 * and would leak which accounts exist.
 */
class DocumentSecretStore implements SecretStore {
  readonly #io: DocumentIO;
  readonly #keySource: KeySource;
  #key: Uint8Array | undefined;
  #cache: Map<string, string> | undefined;

  constructor(io: DocumentIO, keySource: KeySource) {
    this.#io = io;
    this.#keySource = keySource;
  }

  async get(ref: SecretRef): Promise<string | null> {
    assertValidSecretRef(ref);
    return (await this.#load()).get(ref) ?? null;
  }

  async has(ref: SecretRef): Promise<boolean> {
    assertValidSecretRef(ref);
    return (await this.#load()).has(ref);
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    assertValidSecretRef(ref);
    const entries = await this.#load();
    entries.set(ref, value);
    await this.#save(entries);
  }

  async delete(ref: SecretRef): Promise<void> {
    assertValidSecretRef(ref);
    const entries = await this.#load();
    if (entries.delete(ref)) await this.#save(entries);
  }

  async list(prefix?: string): Promise<SecretRef[]> {
    const entries = await this.#load();
    return [...entries.keys()].filter((ref) => !prefix || ref.startsWith(prefix)).sort();
  }

  /** Drop the decrypted copy from memory. */
  forget(): void {
    this.#cache = undefined;
  }

  async #resolveKey(): Promise<Uint8Array> {
    return (this.#key ??= await this.#keySource());
  }

  async #load(): Promise<Map<string, string>> {
    if (this.#cache) return this.#cache;

    const text = await this.#io.read();
    if (text === null) return (this.#cache = new Map());

    const entries = open<Record<string, string>>(
      MAGIC,
      await this.#resolveKey(),
      text,
      this.#io,
      KEY_ENV,
    );
    return (this.#cache = new Map(Object.entries(entries)));
  }

  async #save(entries: Map<string, string>): Promise<void> {
    await this.#io.write(seal(MAGIC, await this.#resolveKey(), Object.fromEntries(entries)));
    this.#cache = entries;
  }
}

export { assertKeyLength };
/** A fresh credential-store key, base64, printed once and stored by the operator. */
export const generateCredentialKey = generateKey;
