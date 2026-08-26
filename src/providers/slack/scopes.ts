import type { ScopeMeaning } from '../scopes.ts';

/**
 * Slack's user-token scopes, said in words before the browser opens.
 *
 * These used to be sixteen lines of a setup page the operator transcribed into
 * a console, where nothing described them and nothing could refuse. Asking for
 * them in a browser is what makes `confirmScopes` apply to Slack at all — the
 * gate ADR-033 recorded as permanently absent here.
 *
 * `broad` is set for the four that reach private conversations and the one that
 * writes as the person. A grant of `search:read.private` is not "search" in the
 * sense a reader assumes: it covers every private channel and DM the account
 * can see, which is usually the most sensitive thing in the workspace.
 */
export const SLACK_SCOPE_MEANINGS: Record<string, ScopeMeaning> = {
  'search:read.public': { meaning: 'search public channels' },
  'search:read.private': { meaning: 'search private channels', broad: true },
  'search:read.im': { meaning: 'search direct messages', broad: true },
  'search:read.mpim': { meaning: 'search group direct messages', broad: true },
  'search:read.users': { meaning: 'search people in the workspace' },
  'search:read.files': { meaning: 'search files' },
  'channels:history': { meaning: 'read messages in public channels' },
  'groups:history': { meaning: 'read messages in private channels', broad: true },
  'im:history': { meaning: 'read direct messages', broad: true },
  'mpim:history': { meaning: 'read group direct messages', broad: true },
  'channels:read': { meaning: 'list public channels' },
  'groups:read': { meaning: 'list private channels' },
  'mpim:read': { meaning: 'list group direct messages' },
  'users:read': { meaning: 'read people and profiles' },
  'chat:write': { meaning: 'send messages as you', broad: true },
  'files:read': { meaning: 'read files and their contents' },
  'reactions:write': { meaning: 'add and remove reactions as you' },
  'canvases:read': { meaning: 'read canvases' },
  'canvases:write': { meaning: 'create and edit canvases' },
  'channels:write': { meaning: 'create and manage public channels' },
};
