import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  READ_BUNDLE,
  WRITE_BUNDLE,
  type Connector,
  type DiscoveredCapability,
  type ToolResult,
} from '#connectivity';

/**
 * The `fs` connector — a directory on this machine.
 *
 * Vendor-neutral, like the rest: it is a folder. iCloud Drive is a manifest
 * pointing at `~/Library/Mobile Documents/com~apple~CloudDocs`, and the same
 * connector serves a Dropbox folder, a Syncthing share, or a project directory.
 *
 * **It only works where the files are.** There is no credential here and nothing
 * to export: access to iCloud Drive is a TCC grant bound to a binary on one Mac,
 * not a token. That is why a cloud instance cannot serve this kind and must
 * instead reach a local one — see `docs/detailed/adr/011-local-filesystem.md`.
 *
 * ## The guard that matters
 *
 * Everything else in this file is ordinary. `confine()` is not: it is the only
 * thing standing between an agent and the rest of the disk, and on a Mac with
 * "Desktop & Documents" syncing, the configured root contains almost everything
 * a person owns. It resolves the *real* path — following symlinks — before
 * comparing, because a symlink inside the root pointing at `~/.ssh` is otherwise
 * a perfectly ordinary-looking file.
 */

export interface FsConnectorOptions {
  readonly root: string;
  readonly maxFileBytes: number;
  /** Names never listed, read, or written. Matched against each path segment. */
  readonly exclude: readonly string[];
  /**
   * How this folder's sync client marks an undownloaded file, if it uses one,
   * and what to tell someone who hits it. Declared by the provider — this
   * transport must not know which client it is.
   */
  readonly placeholder?: { readonly suffix: string; readonly hint?: string | undefined } | undefined;
}


import { fsCapabilities } from './capabilities.ts';
import { ALWAYS_EXCLUDED, OPERATIONS } from './operations.ts';
import { rootOf } from './paths.ts';
import { error } from './result.ts';
import {
  createFolder,
  fileInfo,
  listFiles,
  moveFile,
  readTextFile,
  searchFiles,
  trashFile,
  writeTextFile,
} from './commands.ts';

export function createFsConnector(options: FsConnectorOptions): Connector {
  const excluded = new Set([...ALWAYS_EXCLUDED, ...options.exclude]);

  return {
    kind: 'fs',

    async discover(): Promise<DiscoveredCapability[]> {
      // The root has to exist and be readable. On a machine that is not the one
      // holding the files this fails here, at `connect`, rather than as a
      // puzzling empty listing later.
      await rootOf(options);

      return fsCapabilities();
    },

    /**
     * Which folder this is.
     *
     * There is no account here, so the identity is the location — which is also
     * the only thing that distinguishes two folder connections from each other.
     * Abbreviated to `~` because the absolute form is long and says less.
     */
    async identify(): Promise<string | null> {
      const resolved = await rootOf(options);
      const home = homedir();
      return resolved.startsWith(home + sep) ? `~${resolved.slice(home.length)}` : resolved;
    },

    async invoke(capability, args): Promise<ToolResult> {
      const operation = String(capability.target?.['operation'] ?? capability.name);

      try {
        switch (operation) {
          case OPERATIONS.listFiles:
            return await listFiles(options, excluded, args);
          case OPERATIONS.searchFiles:
            return await searchFiles(options, excluded, args);
          case OPERATIONS.readFile:
            return await readTextFile(options, excluded, args);
          case OPERATIONS.fileInfo:
            return await fileInfo(options, excluded, args);
          case OPERATIONS.writeFile:
            return await writeTextFile(options, excluded, args);
          case OPERATIONS.moveFile:
            return await moveFile(options, excluded, args);
          case OPERATIONS.createFolder:
            return await createFolder(options, excluded, args);
          case OPERATIONS.trashFile:
            return await trashFile(options, excluded, args);
          default:
            return error(`Unknown operation "${operation}".`);
        }
      } catch (failure) {
        return error((failure as Error).message);
      }
    },
  };
}

