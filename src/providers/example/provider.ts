import { z } from 'zod';
import { defineLocalProvider, keepKeys, type ProviderContext } from '#connectivity';

/**
 * The example provider — the reference every other provider is written
 * against, and small enough to reproduce verbatim in
 * `https://lanes.sh/docs/link/creating-a-provider`.
 *
 * It is also load-bearing beyond being a sample. It declares no auth
 * requirement and touches no third-party service, which makes it an *owner
 * provider* in miniature — the same shape memory, skills, and vault take in
 * M3. If this works, that shape is proven before those exist, and `lanes link connect
 * example` opening no browser proves the CLI does not assume OAuth-shaped
 * setup.
 *
 * Note what is absent: no `connection` argument is declared anywhere. Core
 * injects it, fills its enum per profile from resolved policy, and resolves it
 * to `context.connection` before a handler runs. A provider never thinks about
 * which account it is serving — that is ADR-001, and it is what lets one tool
 * set scale to any number of accounts.
 */

const NOTE_KEY_PREFIX = 'note:';

async function readNote(context: ProviderContext, key: string): Promise<string | null> {
  return context.state.get(`${NOTE_KEY_PREFIX}${key}`);
}

export const exampleProvider = defineLocalProvider({
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  description:
    'A trivial provider with no external service. Serves as the provider SDK reference and as a way to exercise connection isolation without any credentials.',

  configSchema: z.object({}),
  connectionSchema: z.object({}),

  bundles: [
    {
      name: 'read',
      description: 'Read notes and echo messages.',
      oauth_scopes: [],
      capabilities: ['echo', 'get_note', 'list_notes'],
      default: true,
    },
    {
      name: 'write',
      description: 'Create and modify notes.',
      oauth_scopes: [],
      capabilities: ['set_note', 'delete_note'],
    },
  ],

  capabilities: [
    {
      kind: 'tool',
      name: 'echo',
      title: 'Echo a message',
      description:
        'Return the supplied message unchanged, prefixed with the connection it was routed to. Useful for confirming which account a call reached.',
      inputSchema: z.object({
        message: z.string().min(1).describe('Text to echo back'),
      }),
      // The message is the whole payload, so recording it verbatim is the
      // useful choice here. A provider handling real content would not.
      redact: keepKeys('message'),
      async handler({ message }, context) {
        return {
          content: [{ type: 'text', text: `[${context.connection.key}] ${message}` }],
        };
      },
    },

    {
      kind: 'tool',
      name: 'set_note',
      title: 'Store a note',
      description:
        'Store a note against this connection. Notes are scoped to the connection, so the same key holds a different value on each one.',
      inputSchema: z.object({
        key: z.string().min(1).describe('Note identifier'),
        value: z.string().describe('Note contents'),
      }),
      // The key is safe to record; the value is the content itself.
      redact: keepKeys('key'),
      async handler({ key, value }, context) {
        await context.state.set(`${NOTE_KEY_PREFIX}${key}`, value);
        context.audit.annotate({ bytes: value.length });

        return {
          content: [{ type: 'text', text: `Stored note "${key}" on ${context.connection.key}.` }],
        };
      },
    },

    {
      kind: 'tool',
      name: 'get_note',
      title: 'Read a note',
      description: 'Read a note stored against this connection.',
      inputSchema: z.object({
        key: z.string().min(1).describe('Note identifier'),
      }),
      redact: keepKeys('key'),
      async handler({ key }, context) {
        const value = await readNote(context, key);

        if (value === null) {
          return {
            content: [
              {
                type: 'text',
                text: `No note "${key}" on ${context.connection.key}.`,
              },
            ],
            isError: true,
          };
        }

        return { content: [{ type: 'text', text: value }] };
      },
    },

    {
      kind: 'tool',
      name: 'delete_note',
      title: 'Delete a note',
      description: 'Remove a note from this connection.',
      inputSchema: z.object({
        key: z.string().min(1).describe('Note identifier'),
      }),
      redact: keepKeys('key'),
      async handler({ key }, context) {
        await context.state.delete(`${NOTE_KEY_PREFIX}${key}`);
        return {
          content: [{ type: 'text', text: `Deleted note "${key}" from ${context.connection.key}.` }],
        };
      },
    },

    {
      kind: 'tool',
      name: 'list_notes',
      title: 'List note keys',
      description: 'List the keys of every note stored against this connection.',
      inputSchema: z.object({}),
      async handler(_input, context) {
        const keys = (await context.state.keys())
          .filter((key) => key.startsWith(NOTE_KEY_PREFIX))
          .map((key) => key.slice(NOTE_KEY_PREFIX.length));

        return {
          content: [
            {
              type: 'text',
              text:
                keys.length > 0
                  ? keys.join('\n')
                  : `No notes on ${context.connection.key} yet.`,
            },
          ],
        };
      },
    },

    /**
     * A resource rather than a tool, deliberately — ADR-006.
     *
     * A note is read-oriented structured context addressed by a stable
     * identifier, which is exactly what resources are for. Making everything a
     * tool is the easy default and the wrong one; the distinction matters much
     * more for M3's memory and skills than it does here, so it is worth
     * exercising now while the cost of getting it wrong is nil.
     */
    {
      kind: 'resource',
      name: 'note',
      title: 'Note',
      description: 'A stored note, addressed by key.',
      uriTemplate: 'example://note/{key}',
      mimeType: 'text/plain',

      async list(context) {
        const keys = await context.state.keys();
        return keys
          .filter((key) => key.startsWith(NOTE_KEY_PREFIX))
          .map((key) => {
            const name = key.slice(NOTE_KEY_PREFIX.length);
            return { uri: `example://note/${encodeURIComponent(name)}`, name };
          });
      },

      async read(uri, params, context) {
        const key = params['key'];
        if (!key) throw new Error(`Malformed note URI: ${uri}`);

        const value = await readNote(context, decodeURIComponent(key));
        if (value === null) throw new Error(`No note "${key}" on ${context.connection.key}`);

        return { uri, mimeType: 'text/plain', text: value };
      },
    },
  ],
});

export default exampleProvider;
