import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep, basename, dirname } from 'node:path';
import { ALWAYS_EXCLUDED } from './operations.ts';
import type { FsConnectorOptions } from './index.ts';

/**
 * Resolving a path, and refusing the ones that leave the root.
 *
 * `confine()` is the only thing standing between an agent and the rest of the
 * disk. It resolves the *real* path — following symlinks — before comparing,
 * because a symlink inside the root pointing at `~/.ssh` is otherwise a
 * perfectly ordinary-looking file. Its own file so that the guard is one thing
 * to read and one thing to review, rather than forty lines in the middle of ten
 * operations.
 */

export async function rootOf(options: FsConnectorOptions): Promise<string> {
  const expanded = options.root.startsWith('~')
    ? join(homedir(), options.root.slice(1))
    : options.root;

  try {
    return await realpath(resolve(expanded));
  } catch {
    throw new Error(
      `The folder ${expanded} is not there. This connector reads files on *this* machine, so it only works where they are.`,
    );
  }
}

/**
 * Resolve a caller-supplied path, and refuse anything outside the root.
 *
 * The real path is resolved first, so a symlink inside the root pointing at
 * `~/.ssh` is caught rather than followed. A path that does not exist yet is
 * checked against its nearest existing ancestor — a write must be confined too,
 * and `realpath` cannot resolve a file that is not there.
 */
export async function confine(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  candidate: unknown,
): Promise<{ absolute: string; relative: string; root: string }> {
  const root = await rootOf(options);
  const requested = typeof candidate === 'string' ? candidate : '';

  if (requested.startsWith('~') || resolve(requested) === requested) {
    // An absolute path or a home-relative one is never what a caller inside a
    // rooted folder means, and accepting it would make the root advisory.
    if (requested !== '') {
      throw new Error(`Give a path relative to the folder root, not "${requested}".`);
    }
  }

  const absolute = resolve(root, requested);

  for (const segment of relative(root, absolute).split(sep)) {
    if (segment && excluded.has(segment)) {
      throw new Error(`"${segment}" is excluded from this folder.`);
    }
  }

  // Walk up to the nearest path that exists, so a not-yet-created file is still
  // confined by where it *would* go.
  let existing = absolute;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`Cannot resolve "${requested}".`);
      existing = parent;
    }
  }

  const within = existing === root || existing.startsWith(root + sep);
  if (!within) {
    throw new Error(
      `"${requested}" resolves outside the folder root, so it was refused. ` +
        `This usually means a symlink pointing elsewhere.`,
    );
  }

  return { absolute, relative: relative(root, absolute) || '.', root };
}

/**
 * Whether the sync client has evicted the file's contents.
 *
 * With "Optimise Mac Storage" on, a file that has not been opened recently is
 * replaced by a hidden `.name<suffix>` placeholder holding a plist, and the real
 * bytes live only in the cloud. Reading the placeholder returns a few hundred
 * bytes of XML — which looks like a corrupt file rather than a missing one, so
 * it is worth naming.
 */
export async function placeholderFor(
  absolute: string,
  suffix: string | undefined,
): Promise<string | null> {
  if (!suffix) return null;
  const candidate = join(dirname(absolute), `.${basename(absolute)}${suffix}`);
  try {
    await stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Whether a directory entry is a sync client's placeholder rather than a file.
 *
 * The suffix is declared by the provider (`placeholder_suffix`), so this
 * transport never learns which sync client it is looking at.
 */
export function isPlaceholder(name: string, suffix: string | undefined): boolean {
  return suffix !== undefined && name.startsWith('.') && name.endsWith(suffix);
}
