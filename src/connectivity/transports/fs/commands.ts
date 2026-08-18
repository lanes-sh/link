import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ToolResult } from '#connectivity';
import { ALWAYS_EXCLUDED } from './operations.ts';
import { confine, isPlaceholder, placeholderFor, rootOf } from './paths.ts';
import { error, json } from './result.ts';
import type { FsConnectorOptions } from './index.ts';

/** The nine operations, as free functions over the connector's options. */

export async function listFiles(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, relative: shown, root } = await confine(options, excluded, args['path']);
  const limit = Math.min(Number(args['limit'] ?? 200) || 200, 500);
  const recursive = args['recursive'] === true;

  const entries: unknown[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= limit) return;

    const found = await readdir(directory, { withFileTypes: true });
    for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= limit) return;
      if (excluded.has(entry.name)) continue;

      // A placeholder is an implementation detail of eviction, reported on the
      // file it stands for rather than listed as a file of its own.
      if (isPlaceholder(entry.name, options.placeholder?.suffix)) continue;

      const full = join(directory, entry.name);
      const info = await stat(full).catch(() => null);

      entries.push({
        path: relative(root, full),
        kind: entry.isDirectory() ? 'folder' : 'file',
        ...(entry.isDirectory()
          ? {}
          : {
              bytes: info?.size ?? null,
              downloaded: (await placeholderFor(full, options.placeholder?.suffix)) === null,
            }),
        modified: info?.mtime.toISOString() ?? null,
      });

      if (recursive && entry.isDirectory() && depth < 8) await walk(full, depth + 1);
    }
  };

  await walk(absolute, 0);

  return json({
    path: shown,
    truncated: entries.length >= limit,
    entries,
  });
}

export async function searchFiles(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, root } = await confine(options, excluded, args['path']);
  const query = String(args['query'] ?? '').toLowerCase();
  if (!query) return error('query is required.');

  const contains = args['contains'] ? String(args['contains']).toLowerCase() : null;
  const limit = Math.min(Number(args['limit'] ?? 50) || 50, 200);
  const matches: unknown[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (matches.length >= limit || depth > 8) return;

    const found = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of found) {
      if (matches.length >= limit) return;
      if (excluded.has(entry.name)) continue;
      if (isPlaceholder(entry.name, options.placeholder?.suffix)) continue;

      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }

      if (!entry.name.toLowerCase().includes(query)) continue;

      if (contains) {
        const info = await stat(full).catch(() => null);
        // Not worth reading a large file into memory to grep it, and a binary
        // has nothing to find.
        if (!info || info.size > options.maxFileBytes) continue;
        const text = await readFile(full, 'utf8').catch(() => null);
        if (!text || !text.toLowerCase().includes(contains)) continue;
      }

      matches.push({ path: relative(root, full) });
    }
  };

  await walk(absolute, 0);

  return json({ query, ...(contains ? { contains: args['contains'] } : {}), matches });
}

export async function readTextFile(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, relative: shown } = await confine(options, excluded, args['path']);

  const placeholder = await placeholderFor(absolute, options.placeholder?.suffix);
  if (placeholder) {
    return error(
      `"${shown}" is not downloaded to this machine — whatever syncs this folder is ` +
        `holding the contents remotely, so there is nothing to read yet.` +
        (options.placeholder?.hint ? `\n${options.placeholder.hint} ${absolute}` : ''),
    );
  }

  const info = await stat(absolute).catch(() => null);
  if (!info) return error(`"${shown}" is not there.`);
  if (info.isDirectory()) return error(`"${shown}" is a folder. Use list_files.`);
  if (info.size > options.maxFileBytes) {
    return error(
      `"${shown}" is ${Math.round(info.size / 1024)}KB, over the ${Math.round(options.maxFileBytes / 1024)}KB limit for one read.`,
    );
  }

  const bytes = await readFile(absolute);
  if (looksBinary(bytes)) {
    return json({
      path: shown,
      bytes: info.size,
      binary: true,
      note: 'Binary file. Its contents are not returned as text.',
    });
  }

  return json({ path: shown, bytes: info.size, content: new TextDecoder().decode(bytes) });
}

export async function fileInfo(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, relative: shown } = await confine(options, excluded, args['path']);
  const info = await stat(absolute).catch(() => null);

  if (!info) {
    const placeholder = await placeholderFor(absolute, options.placeholder?.suffix);
    if (placeholder) return json({ path: shown, downloaded: false, kind: 'file' });
    return error(`"${shown}" is not there.`);
  }

  return json({
    path: shown,
    kind: info.isDirectory() ? 'folder' : 'file',
    bytes: info.size,
    modified: info.mtime.toISOString(),
    created: info.birthtime.toISOString(),
    downloaded: info.isDirectory() ? true : (await placeholderFor(absolute, options.placeholder?.suffix)) === null,
  });
}

export async function writeTextFile(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, relative: shown } = await confine(options, excluded, args['path']);
  const content = String(args['content'] ?? '');

  const existing = await stat(absolute).catch(() => null);
  if (existing?.isDirectory()) return error(`"${shown}" is a folder.`);
  if (existing && args['overwrite'] !== true) {
    // Replacing a file is a different act from creating one, and an agent that
    // meant to create should not silently destroy.
    return error(`"${shown}" already exists. Pass overwrite: true to replace it.`);
  }

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');

  return json({ written: true, path: shown, bytes: Buffer.byteLength(content, 'utf8') });
}

export async function moveFile(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const from = await confine(options, excluded, args['from']);
  const to = await confine(options, excluded, args['to']);

  if (!(await stat(from.absolute).catch(() => null))) return error(`"${from.relative}" is not there.`);
  if (await stat(to.absolute).catch(() => null)) return error(`"${to.relative}" already exists.`);

  await mkdir(dirname(to.absolute), { recursive: true });
  await rename(from.absolute, to.absolute);

  return json({ moved: true, from: from.relative, to: to.relative });
}

export async function createFolder(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, relative: shown } = await confine(options, excluded, args['path']);
  await mkdir(absolute, { recursive: true });
  return json({ created: true, path: shown });
}

/**
 * Move to the system Trash rather than unlinking.
 *
 * Same reasoning as mail: an agent that can permanently destroy a file is a
 * different risk class from one that can tidy up, and the Finder's Trash is a
 * recovery path everyone already knows. If the Trash is on another volume the
 * rename fails, and refusing beats falling back to a real delete.
 */
export async function trashFile(
  options: FsConnectorOptions,
  excluded: ReadonlySet<string>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  const { absolute, relative: shown } = await confine(options, excluded, args['path']);
  if (!(await stat(absolute).catch(() => null))) return error(`"${shown}" is not there.`);

  const trash = join(homedir(), '.Trash');
  let target = join(trash, basename(absolute));
  for (let attempt = 1; await stat(target).catch(() => null); attempt++) {
    target = join(trash, `${basename(absolute)} ${attempt}`);
  }

  try {
    await rename(absolute, target);
  } catch {
    return error(
      `"${shown}" could not be moved to the Trash, and nothing here deletes permanently. Move it somewhere else instead.`,
    );
  }

  return json({ trashed: true, path: shown, recoverable_from: '~/.Trash' });
}

/** A NUL byte in the first block is the practical test for "not text". */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 4096).includes(0);
}
