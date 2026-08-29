import { defineProvider } from '#connectivity';
import {
  CALENDAR_SCOPES,
  CONTACTS_SCOPES,
  FILES_SCOPES,
  GRAPH_BASE_URL,
  MAIL_SCOPES,
  MICROSOFT_APP,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_IDENTITY,
  MICROSOFT_TOKEN_URL,
  TODO_SCOPES,
  specPath,
} from '../shared/oauth.ts';
import { microsoftSetup } from '../shared/setup.ts';

/**
 * Microsoft To Do.
 *
 * Named `microsoft_todo` rather than `todo` for the same reason Google's list is
 * `google_tasks`: `tasks` is the owner layer's own store and is a reserved id,
 * so a vendor's task list has to say whose it is. See ADR-051.
 */
export const microsoftTodo = defineProvider({
  id: 'microsoft_todo',
  name: 'Microsoft To Do',
  description: 'Create, edit, complete, and organise tasks and lists in Microsoft To Do.',
  connector: { kind: 'http', base_url: GRAPH_BASE_URL, openapi: specPath('microsoft-todo.v1.json') },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: MICROSOFT_APP,
    // Declared rather than discovered. An `http` connector has no metadata
    // document to read — a REST API does not announce where its authorization
    // server lives — so the two endpoints are part of the manifest.
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_url: MICROSOFT_TOKEN_URL,
    scopes: TODO_SCOPES,
    revoke_url: 'https://account.live.com/consent/Manage',
  },
  identity: MICROSOFT_IDENTITY,
  setup: microsoftSetup('Microsoft To Do', TODO_SCOPES),
  redact: {
    'me.todo.ListLists': ['top', 'orderby', 'select'],
    // The list's name is what the owner called it, which is theirs.
    'me.todo.CreateLists': [],
    'me.todo.lists.ListTasks': ['todoTaskList-id', 'top', 'orderby', 'select'],
    'me.todo.lists.GetTasks': ['todoTaskList-id', 'todoTask-id', 'select'],
    // Which list, and afterwards which task — never the title or the note.
    'me.todo.lists.CreateTasks': ['todoTaskList-id', 'importance', 'status'],
    'me.todo.lists.UpdateTasks': ['todoTaskList-id', 'todoTask-id', 'importance', 'status'],
    'me.todo.lists.DeleteTasks': ['todoTaskList-id', 'todoTask-id'],
  },
});
