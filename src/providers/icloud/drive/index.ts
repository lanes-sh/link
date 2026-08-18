import { defineProvider } from '#connectivity';

/**
 * iCloud Drive, which is only reachable from the Mac that holds it.
 *
 * Not a fourth service on the same app-specific password: Apple exposes no
 * protocol for Drive at all. What it does expose is a folder, synced by the
 * system, that any process on that Mac may read with the operating system's
 * permission. So this is `auth: none` — there is no credential, and nothing that
 * could be copied to a server somewhere else. ADR-011 covers why the cloud
 * answer has to be a relay to a local instance rather than a stored token.
 */
export const icloudDrive = defineProvider({
  id: 'icloud_drive',
  name: 'iCloud Drive',
  description: 'Read and organise files in iCloud Drive, on the Mac that syncs them.',
  connector: {
    kind: 'fs',
    root: '~/Library/Mobile Documents/com~apple~CloudDocs',
    // Desktop and Documents sync into here, so the root is most of a person's
    // files. The read limit is deliberately modest.
    max_file_bytes: 262_144,
    // macOS names an undownloaded file `.<name>.icloud`, and `brctl` is how you
    // pull it down. Both are Apple's conventions, so both are declared here
    // rather than known by the filesystem transport.
    placeholder: {
      suffix: '.icloud',
      hint: 'Open it once in Finder, or run: brctl download',
    },
  },
  auth: { kind: 'none' },
  identity: { kind: 'connector' },
  redact: {
    // Paths are recorded — an audit line that cannot say *which* file was read
    // answers nothing — but never contents.
    list_files: ['path', 'recursive', 'limit'],
    read_file: ['path'],
    file_info: ['path'],
    // Not `query` or `contains`: a search term is frequently more revealing than
    // the result, which is the same reasoning mail search uses.
    search_files: ['path', 'limit'],
    write_file: ['path', 'overwrite'],
    move_file: ['from', 'to'],
    create_folder: ['path'],
    trash_file: ['path'],
  },
});
