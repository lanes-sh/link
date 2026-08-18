import { READ_BUNDLE, WRITE_BUNDLE, type DiscoveredCapability } from '#connectivity';
import { OPERATIONS, object, pathArgument } from './operations.ts';

/** What an `fs` connection exposes, as data. Fixed — a folder is a folder. */
export function fsCapabilities(): DiscoveredCapability[] {
  return [
        {
          name: OPERATIONS.listFiles,
          description: 'List the entries in a folder.',
          bundle: READ_BUNDLE,
          inputSchema: object({
            path: pathArgument,
            recursive: { type: 'boolean', default: false },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          }),
          target: { operation: OPERATIONS.listFiles },
        },
        {
          name: OPERATIONS.searchFiles,
          description: 'Find files by name, and optionally by the text inside them.',
          bundle: READ_BUNDLE,
          inputSchema: object(
            {
              query: { type: 'string', description: 'Matched against file names.' },
              contains: { type: 'string', description: 'Also require this text in the file.' },
              path: pathArgument,
              limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            ['query'],
          ),
          target: { operation: OPERATIONS.searchFiles },
        },
        {
          name: OPERATIONS.readFile,
          description: 'Read a text file. Binary files report their type and size instead.',
          bundle: READ_BUNDLE,
          inputSchema: object({ path: pathArgument }, ['path']),
          target: { operation: OPERATIONS.readFile },
        },
        {
          name: OPERATIONS.fileInfo,
          description: 'Size, timestamps, and whether the file is downloaded from the cloud.',
          bundle: READ_BUNDLE,
          inputSchema: object({ path: pathArgument }, ['path']),
          target: { operation: OPERATIONS.fileInfo },
        },
        {
          name: OPERATIONS.writeFile,
          description: 'Write a text file, creating it or replacing its contents.',
          bundle: WRITE_BUNDLE,
          inputSchema: object(
            {
              path: pathArgument,
              content: { type: 'string' },
              overwrite: {
                type: 'boolean',
                default: false,
                description: 'Required to replace a file that already exists.',
              },
            },
            ['path', 'content'],
          ),
          target: { operation: OPERATIONS.writeFile },
        },
        {
          name: OPERATIONS.moveFile,
          description: 'Move or rename a file or folder within the root.',
          bundle: WRITE_BUNDLE,
          inputSchema: object({ from: pathArgument, to: pathArgument }, ['from', 'to']),
          target: { operation: OPERATIONS.moveFile },
        },
        {
          name: OPERATIONS.createFolder,
          description: 'Create a folder, including any missing parents.',
          bundle: WRITE_BUNDLE,
          inputSchema: object({ path: pathArgument }, ['path']),
          target: { operation: OPERATIONS.createFolder },
        },
        {
          name: OPERATIONS.trashFile,
          description:
            'Move a file to the system Trash. Recoverable — nothing here deletes permanently.',
          bundle: WRITE_BUNDLE,
          inputSchema: object({ path: pathArgument }, ['path']),
          target: { operation: OPERATIONS.trashFile },
        },
      ];
}
