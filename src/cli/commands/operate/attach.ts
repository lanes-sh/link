import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ownerPrincipal } from '#auth';
import { announce, print, style } from '../../output.ts';
import { grantedConnections, openRuntime, type GlobalFlags } from '../../runtime.ts';

/**
 * `lanes link attach <file> --connection <provider>.<account>`
 *
 * Stage a file locally and print the handle, so a send can name it.
 *
 * The point is the hosted case. A `path` attachment names the filesystem the
 * *endpoint* can see, which on a laptop is the operator's own and on Cloud Run is
 * a container — so `path` stops meaning anything the moment the endpoint is not
 * where the file is. A handle does not care where either end is.
 *
 * It writes to the store directly rather than posting to `/attachments`, which
 * would need the endpoint running and a token in hand. The CLI already holds the
 * profile, so going through the dispatcher is both shorter and the thing that
 * gets it audited identically — one code path for the upload route and this.
 */

export async function attachFile(
  flags: GlobalFlags & { file?: string | undefined; connection?: string | undefined },
): Promise<void> {
  if (!flags.file) {
    throw new Error('Which file? Usage: lanes link attach <file> --connection <provider>.<account>');
  }
  if (!flags.connection) {
    throw new Error(
      'Which account is it for? Usage: lanes link attach <file> --connection <provider>.<account>. A staged file belongs to one account, not to the endpoint.',
    );
  }

  const [providerId, ...rest] = flags.connection.split('.');
  const connectionId = rest.join('.');
  if (!providerId || !connectionId) {
    throw new Error(`"${flags.connection}" is not a connection. Use <provider>.<account>.`);
  }

  const runtime = await openRuntime(flags);
  try {
    announce(runtime.resolution);

    // Checked against config rather than trusted, so a typo names the mistake
    // instead of staging into a namespace nothing will ever read.
    const known = grantedConnections(runtime).some(
      (connection) => connection.provider === providerId && connection.id === connectionId,
    );
    if (!known) {
      const have = grantedConnections(runtime).map((c) => `${c.provider}.${c.id}`);
      throw new Error(
        `No connection "${flags.connection}" in this profile. Configured: ${have.join(', ') || 'none'}.`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(flags.file));
    } catch (failure) {
      throw new Error(`Could not read ${flags.file}: ${(failure as Error).message}`);
    }

    if (bytes.byteLength === 0) {
      throw new Error(`${flags.file} is empty, so there is nothing to stage.`);
    }

    const filename = basename(flags.file);
    const staged = await runtime.dispatcher.stageAttachment({
      // The operator, at their own terminal — the same principal every other
      // control-plane command runs as.
      principal: ownerPrincipal(runtime.config.instance.profile),
      providerId,
      connectionId,
      bytes,
      filename,
      contentType: contentTypeFor(filename),
      clientLabel: 'cli',
    });

    print('');
    print(`${style.bold(staged.handle)}  ${filename}  ${bytes.byteLength} bytes`);
    print(style.dim(`sha256 ${staged.sha256}`));
    print(style.dim(`expires ${new Date(staged.expiresAt).toISOString()}`));
    print('');
    print('Attach it by handle:');
    print(style.dim(`  { "handle": "${staged.handle}" }`));
  } finally {
    await runtime.close();
  }
}

/**
 * Enough of a type to be useful, and octet-stream otherwise.
 *
 * Deliberately not a mime database. The resolver guesses from the filename too,
 * and a wrong-but-generic type shows as a file rather than breaking anything.
 */
const TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function contentTypeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  return (extension ? TYPES[extension] : undefined) ?? 'application/octet-stream';
}
