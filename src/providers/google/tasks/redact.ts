/**
 * What survives into the audit log when a task is read or changed.
 *
 * `title` and `notes` are the task — the same call as Gmail's `labels.create`,
 * where the name is the user's own words and the log has no business keeping
 * them. `due` and `status` are kept, because "marked the thing due Friday done"
 * is the shape of the change and neither argument says what the thing was.
 *
 * Two argument names are not what they look like, and a wrong key here fails
 * silently — the lookup misses, every value is withheld, and it reads exactly
 * like working redaction. The generator disambiguates a collision between a
 * path or query parameter and a body field by prefixing the location, so
 * `tasks.insert` takes `queryParent` (the query one) beside the body's
 * `parent`. `tasks.move` has no such collision and takes a plain `parent`.
 */
export const TASKS_REDACT: Record<string, string[]> = {
  'tasklists.list': ['maxResults'],
  'tasklists.insert': [],
  'tasklists.patch': ['tasklist'],
  'tasks.list': [
    'tasklist',
    'showCompleted',
    'showDeleted',
    'showHidden',
    'dueMin',
    'dueMax',
    'maxResults',
  ],
  'tasks.get': ['tasklist', 'task'],
  'tasks.insert': ['tasklist', 'queryParent', 'previous', 'due', 'status'],
  'tasks.patch': ['tasklist', 'task', 'due', 'status'],
  'tasks.delete': ['tasklist', 'task'],
  'tasks.move': ['tasklist', 'task', 'parent', 'previous'],
};
