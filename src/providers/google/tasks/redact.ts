/**
 * What survives into the audit log when a task is read or changed.
 *
 * `title` and `notes` are the task — the same call as Gmail's `labels.create`,
 * where the name is the user's own words and the log has no business keeping
 * them. `due` and `status` are kept, because "marked the thing due Friday done"
 * is the shape of the change and neither argument says what the thing was.
 *
 * **The keys carry Google's whole operationId**, `tasks.tasks.patch` rather than
 * `tasks.patch`. `shortenName` strips the provider id from a discovered tool
 * name, and this provider's id is `google_tasks` while the API namespaces its
 * operations under `tasks` — so nothing is stripped and the capability is
 * `google_tasks.tasks.patch`. `contacts` has read this way since it shipped: its
 * id is `contacts` and the People API says `people.people.searchContacts`. The
 * keys were the short form while the id was `tasks` and the prefix happened to
 * match; renaming the provider for the built-in task list (ADR-051) ended the
 * coincidence.
 *
 * Two argument names are not what they look like, and a wrong key here fails
 * silently — the lookup misses, every value is withheld, and it reads exactly
 * like working redaction. The generator disambiguates a collision between a
 * path or query parameter and a body field by prefixing the location, so
 * `tasks.tasks.insert` takes `queryParent` (the query one) beside the body's
 * `parent`. `tasks.tasks.move` has no such collision and takes a plain `parent`.
 */
export const TASKS_REDACT: Record<string, string[]> = {
  'tasks.tasklists.list': ['maxResults'],
  'tasks.tasklists.insert': [],
  'tasks.tasklists.patch': ['tasklist'],
  'tasks.tasks.list': [
    'tasklist',
    'showCompleted',
    'showDeleted',
    'showHidden',
    'dueMin',
    'dueMax',
    'maxResults',
  ],
  'tasks.tasks.get': ['tasklist', 'task'],
  'tasks.tasks.insert': ['tasklist', 'queryParent', 'previous', 'due', 'status'],
  'tasks.tasks.patch': ['tasklist', 'task', 'due', 'status'],
  'tasks.tasks.delete': ['tasklist', 'task'],
  'tasks.tasks.move': ['tasklist', 'task', 'parent', 'previous'],
};
