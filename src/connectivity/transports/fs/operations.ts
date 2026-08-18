/**
 * The operation names an `fs` connection exposes, plus the exclusions and
 * argument shapes they share.
 *
 * `ALWAYS_EXCLUDED` is a security control rather than a tidiness one: the
 * configured root on a Mac with Desktop & Documents syncing contains almost
 * everything a person owns, and these are the names that must never be listed
 * or read whatever the manifest says.
 */

export const OPERATIONS = {
  listFiles: 'list_files',
  readFile: 'read_file',
  searchFiles: 'search_files',
  fileInfo: 'file_info',
  writeFile: 'write_file',
  moveFile: 'move_file',
  createFolder: 'create_folder',
  trashFile: 'trash_file',
} as const;

/**
 * Never traversed, whatever the manifest says.
 *
 * `.git` is here because a repository in a synced folder holds credentials in
 * its config and the entire history of everything else; the rest are metadata
 * nobody means to read.
 */
export const ALWAYS_EXCLUDED = ['.git', '.ssh', '.gnupg', 'node_modules', '.DS_Store', '.Trash'];

export const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

export const pathArgument = {
  type: 'string',
  description: 'Path relative to the folder root. "" or "." is the root itself.',
};

