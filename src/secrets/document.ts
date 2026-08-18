import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { BlobStore } from '#stores/blobs';

/**
 * One encrypted document, and everything that goes into keeping one.
 *
 * This exists because there were two of these. The system credential store and
 * the vault had each grown their own AES-256-GCM envelope, their own
 * write-then-rename, their own "read the key from an env var, else a sibling
 * `.key` file, else mint one at 0600", and their own decrypt-failure message —
 * differing in a magic string and nothing else that mattered. Two
 * implementations of a format is two chances to get a format wrong, and the one
 * this project cannot afford to get wrong is this one.
 *
 * What is *not* merged is the two stores themselves. They keep separate
 * documents, separate keys, and separate environment variables, because that is
 * the boundary `docs/detailed/security.md` is built on: one master secret reused across
 * purposes turns any single compromise into a total one. Sharing the code that
 * seals a document is the opposite of sharing the key that opens it.
 *
 * **The whole document is encrypted, names included.** A credential store whose
 * key names were readable would disclose which accounts exist and how many;
 * a vault whose item names were readable would disclose what the owner keeps.
 */

const FORMAT_VERSION = 1;
export const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard; 96 bits is what the mode is specified for.

interface EncryptedDocument {
  readonly magic: string;
  readonly version: number;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/**
 * Where a document is kept.
 *
 * Deliberately smaller than a storage interface: read it, write it, and say what
 * to call it in an error. Nothing about the ciphertext depends on which
 * implementation is in use, which is what lets a target switch without the
 * format changing.
 */
export interface DocumentIO {
  /** The stored document, or null when nothing has been written yet. */
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** Named in every error, so "could not decrypt" says which document. */
  readonly label: string;
  /** Where to look for the key, appended to the remediation in a decrypt error. */
  readonly keyHint: string;
}

/** Resolve the 32-byte key, however this target supplies one. */
export type KeySource = () => Promise<Uint8Array>;

export function fileDocumentIO(path: string, keyPath: string): DocumentIO {
  return {
    label: path,
    keyHint: ` or ${keyPath}`,

    async read() {
      return existsSync(path) ? readFile(path, 'utf8') : null;
    },

    async write(text) {
      await mkdir(dirname(path), { recursive: true });

      // Write-then-rename so a crash cannot leave a truncated store.
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
  };
}

export function blobDocumentIO(store: BlobStore, key: string): DocumentIO {
  return {
    label: key,
    keyHint: '',

    async read() {
      const bytes = await store.get(key);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },

    async write(text) {
      await store.put(key, new TextEncoder().encode(text), { contentType: 'application/json' });
    },
  };
}

/**
 * The document as one entry in a secret store.
 *
 * Structurally typed rather than importing `SecretStore` from `./index.ts`,
 * which imports this file — a type-only cycle would erase cleanly, but the two
 * methods used are the whole of what is needed and naming them is clearer than
 * pointing back up.
 *
 * The size guard is Secret Manager's payload limit. Hitting it should say what
 * happened and what the ceiling is, rather than surfacing as a REST error from
 * inside a write that already looked like it was going to work.
 */
export function secretDocumentIO(
  store: {
    get(ref: string): Promise<string | null>;
    set(ref: string, value: string): Promise<void>;
  },
  ref: string,
  limitBytes = 64 * 1024,
): DocumentIO {
  return {
    label: ref,
    keyHint: '',

    read: () => store.get(ref),

    async write(text) {
      const size = new TextEncoder().encode(text).byteLength;
      if (size > limitBytes) {
        throw new Error(
          `The vault document is ${size} bytes, over the ${limitBytes}-byte limit for one secret. ` +
            'A vault holds keys and passwords; something much larger than that belongs in a file.',
        );
      }
      await store.set(ref, text);
    },
  };
}

/**
 * A key from the environment, from a sibling file, or newly minted.
 *
 * The order matters and so does the fallback's absence in the blob case: a file
 * store may mint a key on first use because it can write it beside the document
 * at 0600 and that file survives the process. A deployment has nowhere
 * equivalent to put one — writing it beside the ciphertext it protects would
 * encrypt nothing, and generating a fresh key per revision would make every
 * previously stored item permanently unreadable while looking like it worked.
 */
export function fileKeySource(input: {
  readonly keyPath: string;
  readonly envVar: string;
  readonly env: Record<string, string | undefined>;
  readonly explicit?: Uint8Array | undefined;
}): KeySource {
  return async () => {
    const explicit = explicitKey(input.explicit, input.env, input.envVar);
    if (explicit) return explicit;

    if (existsSync(input.keyPath)) {
      const decoded = decodeKey(await readFile(input.keyPath, 'utf8'));
      assertKeyLength(decoded, input.keyPath);
      return decoded;
    }

    const generated = new Uint8Array(randomBytes(KEY_BYTES));
    await mkdir(dirname(input.keyPath), { recursive: true });
    // Written 0600 from the start rather than chmod-ed afterwards, so there is
    // no window in which the key is world-readable.
    await writeFile(input.keyPath, Buffer.from(generated).toString('base64'), { mode: 0o600 });
    await chmod(input.keyPath, 0o600);
    return generated;
  };
}

export function envOnlyKeySource(input: {
  readonly envVar: string;
  readonly env: Record<string, string | undefined>;
  readonly explicit?: Uint8Array | undefined;
  readonly label: string;
  /** The command that mints one, named because the caller knows which store this is. */
  readonly remedy: string;
}): KeySource {
  return async () => {
    const explicit = explicitKey(input.explicit, input.env, input.envVar);
    if (explicit) return explicit;

    throw new Error(
      `${input.label}: ${input.envVar} is required for a blob-backed store. ` +
        `Generate one with "${input.remedy}" and store it in the deployment's secret manager — ` +
        'this adapter will not mint a key, because a key it generated would be lost with the ' +
        'process and take every stored item with it.',
    );
  };
}

function explicitKey(
  provided: Uint8Array | undefined,
  env: Record<string, string | undefined>,
  envVar: string,
): Uint8Array | null {
  if (provided) {
    assertKeyLength(provided, 'the key passed to the store');
    return provided;
  }

  const fromEnv = env[envVar];
  if (!fromEnv) return null;

  const decoded = decodeKey(fromEnv);
  assertKeyLength(decoded, envVar);
  return decoded;
}

export function decodeKey(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.trim(), 'base64'));
}

export function assertKeyLength(key: Uint8Array, source: string): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${source} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
}

/** A fresh key, base64, printed once and stored by the operator. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** Seal a payload into the on-disk envelope. */
export function seal(magic: string, key: Uint8Array, payload: unknown): string {
  const iv = randomBytes(IV_BYTES); // Fresh per write; reuse under GCM is catastrophic.
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  const document: EncryptedDocument = {
    magic,
    version: FORMAT_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return JSON.stringify(document, null, 2);
}

/**
 * Open a sealed document, or refuse.
 *
 * GCM authentication failing means the wrong key or an altered document. Both
 * are refusals, never a partial read — a store that returned what it could
 * decrypt would be a store an attacker can truncate.
 */
export function open<T>(
  magic: string,
  key: Uint8Array,
  text: string,
  io: Pick<DocumentIO, 'label' | 'keyHint'>,
  envVar: string,
): T {
  const document = JSON.parse(text) as EncryptedDocument;

  if (document.magic !== magic) {
    throw new Error(`${io.label}: not a ${magic} document (found ${JSON.stringify(document.magic)}).`);
  }
  if (document.version !== FORMAT_VERSION) {
    throw new Error(
      `${io.label}: format version ${document.version}, but this build understands ${FORMAT_VERSION}.`,
    );
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(document.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(document.tag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(document.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error(
      `${io.label}: could not decrypt. The key is wrong or the document has been modified. ` +
        `Check ${envVar}${io.keyHint}.`,
    );
  }
}
