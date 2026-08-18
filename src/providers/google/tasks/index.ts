import { defineProvider } from '#connectivity';
import { GOOGLE_APP, GOOGLE_OAUTH, specPath } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';
import { TASKS_REDACT } from './redact.ts';

/**
 * The narrowest scope Google offers here is the widest one there is.
 *
 * Tasks publishes exactly two: `tasks` and `tasks.readonly`. There is no
 * per-list scope, no app-created scope, and no separate create verb — so adding
 * one task to one list means holding read, write, and delete over every list in
 * the account. It is marked broad in `../shared/scopes.ts` for that reason, and
 * unlike `gmail.modify` or `spreadsheets` there was no alternative to weigh:
 * this is not the widest of several, it is the only one that can write at all.
 *
 * What bounds it is what bounds the others. The token can delete a whole list;
 * the tool surface cannot, because `tasklists.delete` is not vendored — Tasks
 * has no trash, so destroying a list destroys every task in it. `lanes link
 * policy deny tasks.*` narrows it further.
 *
 * No `identity` block, and that is a decision rather than an omission. Nothing
 * reachable under `auth/tasks` returns an address: `tasklists.list` answers
 * with titles, and `userinfo.email` is a scope this provider has no other use
 * for. Adding one for a cosmetic label is exactly what the documented-minimum
 * rule refuses, so `connect` asks instead — and because it matches the typed
 * address against existing connections, a reconnect still repairs the row it
 * already made rather than appending `main2`.
 *
 * Version in the path, host without it (`tasks.googleapis.com` +
 * `/tasks/v1/lists/...`) — the Sheets shape, not Drive's.
 */
const TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'];

export const tasks = defineProvider({
  id: 'tasks',
  name: 'Google Tasks',
  description:
    'Read and write task lists and tasks — create, edit, complete, reorder, and delete — via the Tasks REST API.',
  connector: {
    kind: 'http',
    base_url: 'https://tasks.googleapis.com',
    openapi: specPath('tasks.v1.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: TASKS_SCOPES,
    ...GOOGLE_OAUTH,
  },
  setup: googleSetup('Tasks', TASKS_SCOPES, { apis: ['tasks.googleapis.com'] }),
  redact: TASKS_REDACT,
});
