import { ConfigError } from '#profile';
import { scopeNamespace } from '#dispatch';
import { scopeBlobStore, type BlobStore } from '#stores/blobs';
import { memoryStorage } from '#providers/owner.ts';
import { heading, ok, print, style, table } from '../../output.ts';
import type { Runtime } from '../../runtime.ts';
import {
  agreed,
  ownerConnection,
  readStdin,
  required,
  withRuntime,
  type OwnerFlags,
} from './shared.ts';

/** `lanes link memory` — the owner's persistent, accumulated knowledge. */

export async function memoryList(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const store = memoryStore(runtime, flags);
    const entries = (await memoryStorage.all(store)).filter(
      (entry) => !flags.tag || entry.tags.includes(flags.tag),
    );

    heading(`Memory (${entries.length})`);
    if (entries.length === 0) {
      print(style.dim('  none — write one with: lanes link memory write <id> --title <title>'));
      return;
    }

    table(
      entries.map((entry) => [
        `  ${entry.id}`,
        entry.title,
        entry.tags.length > 0 ? style.dim(entry.tags.join(', ')) : '',
        style.dim(entry.updatedAt.slice(0, 10)),
      ]),
    );
  });
}

export async function memoryGet(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const entryId = required(id, 'lanes link memory get <id>');

  await withRuntime(flags, async (runtime) => {
    const entry = await memoryStorage.read(memoryStore(runtime, flags), entryId);
    if (!entry) throw new ConfigError(`No memory entry "${entryId}" in this profile.`);

    print('');
    print(entry.body);
  });
}

export async function memoryWrite(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const given = required(id, 'lanes link memory write <id> --title <title>   (body on stdin)');
  const text = await readStdin(
    `lanes link memory write ${given} --title "<title>"`,
    'the entry body',
  );

  await withRuntime(flags, async (runtime) => {
    const store = memoryStore(runtime, flags);
    const existing = await memoryStorage.read(store, given);

    // The title is what a listing and a search show, so it is worth keeping
    // when a rewrite does not supply one — losing it silently would leave an
    // entry titled after its own id for no reason the owner asked for.
    const title = flags.title ?? existing?.title ?? given;
    const document = memoryStorage.serialise({
      title,
      tags: flags.tag ? [flags.tag] : (existing?.tags ?? []),
      updatedAt: new Date().toISOString(),
      body: text,
    });

    await store.put(memoryStorage.key(given), new TextEncoder().encode(document), {
      contentType: 'text/markdown',
    });

    print(ok(`${existing ? 'replaced' : 'wrote'} memory entry ${style.bold(given)}`));
  });
}

export async function memoryForget(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const entryId = required(id, 'lanes link memory forget <id>');

  await withRuntime(flags, async (runtime) => {
    const store = memoryStore(runtime, flags);
    const entry = await memoryStorage.read(store, entryId);
    if (!entry) throw new ConfigError(`No memory entry "${entryId}" in this profile.`);

    print(`  ${style.bold(entry.id)}  ${entry.title}`);
    if (!(await agreed(flags, 'Forget this entry?'))) return;

    await store.delete(memoryStorage.key(entryId));
    print(ok(`forgot memory entry ${style.bold(entryId)}`));
  });
}

/**
 * The blob namespace core would scope this provider to.
 *
 * Built here from `scopeNamespace` and `scopeBlobStore` — the same two
 * functions `buildProviderContext` uses — rather than from a path spelled out
 * again, so the CLI cannot address a different directory from the provider.
 */
export function memoryStore(runtime: Runtime, flags: OwnerFlags): BlobStore {
  const connection = ownerConnection(runtime.config, 'lanes_memory', flags);
  return scopeBlobStore(runtime.storage, scopeNamespace('lanes_memory', connection));
}
