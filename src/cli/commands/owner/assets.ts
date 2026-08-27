import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ConfigError } from '#profile';
import { scopeNamespace } from '#dispatch';
import { scopeBlobStore, type BlobStore } from '#stores/blobs';
import { assetStorage } from '#providers/owner.ts';
import { heading, ok, print, style, table } from '../../output.ts';
import type { Runtime } from '../../runtime.ts';
import {
  agreed,
  ownerConnection,
  required,
  withRuntime,
  type OwnerFlags,
} from './shared.ts';

/** `lanes link assets` — files the owner wants kept. */

export async function assetsList(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const assets = await assetStorage.all(assetsStore(runtime, flags));

    heading(`Assets (${assets.length})`);
    if (assets.length === 0) {
      print(style.dim('  none — keep one with: lanes link assets add <file>'));
      return;
    }

    table(
      assets.map((asset) => [
        `  ${asset.name}`,
        style.dim(asset.contentType),
        style.dim(assetStorage.humanBytes(asset.bytes)),
        style.dim(asset.modifiedAt.slice(0, 10)),
      ]),
    );
  });
}

/**
 * `lanes link assets add <file>` — a path on this machine.
 *
 * Only a path, where the capability takes five sources. The other four exist
 * because the endpoint may not be on the caller's machine; a CLI is, by
 * definition, already there, so a URL or a staged handle here would be
 * ceremony over `curl -O`.
 */
export async function assetsAdd(path: string | undefined, flags: OwnerFlags): Promise<void> {
  const from = required(path, 'lanes link assets add <file>');

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(from));
  } catch (failure) {
    const code = (failure as { code?: string }).code;
    if (code === 'ENOENT') throw new ConfigError(`No file at ${from}.`);
    if (code === 'EISDIR') throw new ConfigError(`${from} is a directory, not a file.`);
    throw new ConfigError(`Could not read ${from} — ${(failure as Error).message}`);
  }

  const name = flags.name ?? basename(from);
  assetStorage.assertName(name);

  await withRuntime(flags, async (runtime) => {
    const store = assetsStore(runtime, flags);
    const replaced = await store.has(name);

    // Only when told. Left off, the store infers from the extension and writes no
    // sidecar; `--content-type` is for the file whose name does not say what it
    // is, which is the only case worth a `<name>.meta` beside it.
    await store.put(name, bytes, flags.contentType ? { contentType: flags.contentType } : {});

    print(
      ok(
        `${replaced ? 'replaced' : 'kept'} ${style.bold(name)} — ` +
          `${assetStorage.humanBytes(bytes.byteLength)}, sha256 ${assetStorage.digest(bytes).slice(0, 12)}…`,
      ),
    );
  });
}

/**
 * `lanes link assets get <name>` — write the bytes to stdout.
 *
 * Bytes rather than a description, unlike the capability: this end of the pipe is
 * a shell, so `lanes link assets get invoice.pdf > invoice.pdf` is the useful
 * thing and there is no context window to protect. Refuses a terminal for the
 * same reason `curl` warns about it — binary into a tty is a mess nobody wanted.
 */
export async function assetsGet(name: string | undefined, flags: OwnerFlags): Promise<void> {
  const wanted = required(name, 'lanes link assets get <name> > <file>');

  await withRuntime({ ...flags, raw: true }, async (runtime) => {
    const store = assetsStore(runtime, flags);
    const bytes = await store.get(wanted);
    if (bytes === null) throw new ConfigError(`No asset "${wanted}" in this profile.`);

    if (process.stdout.isTTY) {
      throw new ConfigError(
        `"${wanted}" would be written to your terminal. Redirect it:\n` +
          `  lanes link assets get ${wanted} > ${wanted}`,
      );
    }

    await Bun.write(Bun.stdout, bytes);
  });
}

export async function assetsRemove(name: string | undefined, flags: OwnerFlags): Promise<void> {
  const wanted = required(name, 'lanes link assets remove <name>');

  await withRuntime(flags, async (runtime) => {
    const store = assetsStore(runtime, flags);
    const asset = await assetStorage.find(store, wanted);
    if (!asset) throw new ConfigError(`No asset "${wanted}" in this profile.`);

    print(`  ${style.bold(asset.name)}  ${assetStorage.describe(asset)}`);
    if (!(await agreed(flags, 'Delete this file?'))) return;

    await store.delete(wanted);
    print(ok(`deleted ${style.bold(wanted)}`));
  });
}

/**
 * The blob namespace core would scope this provider to — see `tasks.ts` for why
 * it is built from the same two functions rather than spelled as a path.
 */
export function assetsStore(runtime: Runtime, flags: OwnerFlags): BlobStore {
  const connection = ownerConnection(runtime.config, 'assets', flags);
  return scopeBlobStore(runtime.storage, scopeNamespace('assets', connection));
}
