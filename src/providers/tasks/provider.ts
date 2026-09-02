import { z } from 'zod';
import { defineLocalProvider, keepKeys, type ProviderDefinition } from '#connectivity';
import {
  ACTIVE_STATUSES,
  TASK_STATUSES,
  allTasks,
  assertTaskId,
  readTask,
  slugify,
  taskKey,
  writeTask,
  type Task,
  type TaskStatus,
} from './store.ts';

/**
 * `tasks` — what the owner has to do.
 *
 * **This exists because memory was being used for it.** "Remember to chase the
 * invoice" was landing in `memory.write`, and memory has no way to express that
 * something is finished: an entry is a fact, facts do not close, and nothing
 * ever removed it. A task carries a status, which is the whole difference, and
 * the routing rule is stated where an agent reads it — the paragraph in
 * `#server/mcp`'s instructions and the bundled skill both say that a thing to
 * *do* goes here and a thing that is merely *true* goes in memory. ADR-051.
 *
 * Everything else is memory's design, deliberately unchanged: one Markdown file
 * per task in the `BlobStore` core scoped to `tasks/<connection>`, reading and
 * writing as separate capabilities, no index. The format lives in `./store.ts`.
 *
 * **Reading and writing are separate**, for the reason ADR-012 §2 gives for
 * memory: text an agent authors is stored once and re-served to every later
 * session, including to a different agent. A task list is a smaller version of
 * that risk rather than a different one — an injected "task" is an instruction
 * with a due date — so the split is the same and so is the one-line narrowing,
 * `deny: [tasks.add, tasks.update, tasks.remove]`.
 */

const DEFAULT_LIMIT = 20;

const statusSchema = z.enum(TASK_STATUSES);

/** `in_progress · chase the invoice  (due 2026-09-01) [billing]` */
function line(task: Task): string {
  const tags = task.tags.length > 0 ? ` [${task.tags.join(', ')}]` : '';
  const due = task.due ? `  (due ${task.due})` : '';
  return `${task.status} · ${task.title}${due}${tags}`;
}

/** Whether a task matches a free-text query, over the parts a person would search. */
function matches(task: Task, needle: string): boolean {
  return (
    task.title.toLowerCase().includes(needle) ||
    task.body.toLowerCase().includes(needle) ||
    task.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

export const tasksProvider: ProviderDefinition = defineLocalProvider({
  id: 'lanes_tasks',
  name: 'Tasks',
  version: '1.0.0',
  description:
    "What the owner has to do. A task carries a status, which is why this is not memory: use it for anything to be done, and memory for what is merely true. Writing is a separate capability from reading.",

  configSchema: z.object({}),
  connectionSchema: z.object({}),

  bundles: [
    {
      name: 'read',
      description: 'List and read tasks.',
      oauth_scopes: [],
      capabilities: ['task', 'list', 'get'],
      default: true,
    },
    {
      name: 'write',
      description: 'Add tasks, change their status, and delete them.',
      oauth_scopes: [],
      capabilities: ['add', 'update', 'remove'],
    },
  ],

  capabilities: [
    /**
     * Retrieval by address — a resource, not a tool, on ADR-006's rule: the
     * answer is a function of the URI alone. The same case memory's `entry` is.
     */
    {
      kind: 'resource',
      name: 'task',
      title: 'Task',
      description: 'One task, addressed by its id.',
      uriTemplate: 'lanes-tasks://task/{id}',
      mimeType: 'text/markdown',
      redact: keepKeys('uri'),

      async list(context) {
        return (await allTasks(context.storage)).map((task) => ({
          uri: `lanes-tasks://task/${encodeURIComponent(task.id)}`,
          name: task.title,
        }));
      },

      async read(uri, params, context) {
        const raw = params['id'];
        if (!raw) throw new Error(`Malformed task URI: ${uri}`);

        const id = decodeURIComponent(raw);
        const task = await readTask(context.storage, id);
        if (task === null) throw new Error(`No task "${id}" on ${context.connection.key}`);

        return { uri, mimeType: 'text/markdown', text: describe(task) };
      },
    },

    {
      kind: 'tool',
      name: 'list',
      title: 'List tasks',
      description:
        'Tasks the owner has open. Shows in_progress, open and blocked by default — finished, dropped and muted work is excluded unless you name a status, because the question is almost always what is outstanding. Ordered by status, then due date.',
      inputSchema: z.object({
        status: z
          .array(statusSchema)
          .optional()
          .describe('Statuses to include. Defaults to in_progress, open and blocked.'),
        tag: z.string().optional().describe('Restrict to tasks carrying this tag'),
        query: z.string().optional().describe('Free text to look for in the title, notes, or tags'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Maximum results (default ${DEFAULT_LIMIT})`),
      }),
      // Nothing kept. A task query is as revealing as a memory search: it is
      // the owner's own material being asked for by name.
      async handler({ status, tag, query, limit }, context) {
        const wanted = new Set<TaskStatus>(status ?? ACTIVE_STATUSES);
        const needle = query?.toLowerCase();

        const all = await allTasks(context.storage);
        const found = all.filter(
          (task) =>
            wanted.has(task.status) &&
            (!tag || task.tags.includes(tag)) &&
            (!needle || matches(task, needle)),
        );
        const shown = found.slice(0, limit ?? DEFAULT_LIMIT);

        context.audit.annotate({ scanned: all.length, matched: found.length });

        if (shown.length === 0) {
          const scope = status ? 'matching' : 'outstanding';
          return {
            content: [
              { type: 'text', text: `No ${scope} tasks on ${context.connection.key}.` },
            ],
          };
        }

        // `resource_link` rather than a URI written into the text: core routes
        // the link to the profile and connection this call was made on, and a
        // provider must not learn either.
        return {
          content: [
            ...shown.flatMap((task) => [
              {
                type: 'resource_link' as const,
                uri: `lanes-tasks://task/${encodeURIComponent(task.id)}`,
                name: task.title,
              },
              { type: 'text' as const, text: `${task.id}  ${line(task)}` },
            ]),
            ...(found.length > shown.length
              ? [
                  {
                    type: 'text' as const,
                    text: `… ${found.length - shown.length} more. Raise limit, or narrow with tag or query.`,
                  },
                ]
              : []),
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'get',
      title: 'Read a task',
      description:
        'Return one task by id, notes included. The resource lanes-tasks://task/{id} is the same content; this exists for clients that do not read resources.',
      inputSchema: z.object({ id: z.string().min(1).describe('Task id') }),
      redact: keepKeys('id'),
      async handler({ id }, context) {
        const task = await readTask(context.storage, id);

        if (task === null) {
          return {
            content: [{ type: 'text', text: `No task "${id}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        return { content: [{ type: 'text', text: describe(task) }] };
      },
    },

    {
      kind: 'tool',
      name: 'add',
      title: 'Add a task',
      description:
        'Record something to be done. This is where "remember to…", "add a todo", and "do not let me forget…" belong — not memory, which has no way to say a thing is finished.',
      inputSchema: z.object({
        title: z.string().min(1).describe('What is to be done, in one line'),
        notes: z.string().optional().describe('Detail, as Markdown'),
        status: statusSchema.optional().describe('Defaults to open'),
        due: z
          .string()
          .optional()
          .describe('When it is due, as the owner would write it — 2026-09-01, or an instant'),
        tags: z.array(z.string()).optional().describe('Labels for filtering'),
        id: z
          .string()
          .optional()
          .describe('Task id. Derived from the title when omitted; naming an existing one replaces it.'),
      }),
      // The title and notes are the owner's own words; the rest is the shape of
      // the change, which is what makes a write log worth having.
      redact: keepKeys('id', 'status', 'due', 'tags'),
      async handler({ title, notes, status, due, tags, id }, context) {
        const taskId = id ?? slugify(title);
        assertTaskId(taskId);

        const now = new Date().toISOString();
        const existing = await readTask(context.storage, taskId);

        await writeTask(context.storage, {
          id: taskId,
          title,
          status: status ?? 'open',
          tags: tags ?? [],
          ...(due ? { due } : {}),
          // Preserved across a replace: when a task was first recorded is a fact
          // about the task, not about the last time something touched it.
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          body: notes ?? '',
        });

        context.audit.annotate({ task: taskId, replaced: existing !== null });

        return {
          content: [
            {
              type: 'text',
              text: `${existing ? 'Replaced' : 'Added'} task "${taskId}" on ${context.connection.key}.`,
            },
            { type: 'resource_link', uri: `lanes-tasks://task/${taskId}`, name: title },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'update',
      title: 'Change a task',
      description:
        'Change a task in place — most often its status. Marking something done is an update, not a delete: the record of having done it is the useful part. Omitted fields are left as they are.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Task id'),
        status: statusSchema.optional().describe('The new status'),
        title: z.string().optional().describe('Replaces the title'),
        notes: z.string().optional().describe('Replaces the notes'),
        due: z.string().optional().describe('Replaces the due date. Pass "" to clear it.'),
        tags: z.array(z.string()).optional().describe('Replaces the tags'),
      }),
      redact: keepKeys('id', 'status', 'due', 'tags'),
      async handler({ id, status, title, notes, due, tags }, context) {
        const existing = await readTask(context.storage, id);

        if (existing === null) {
          return {
            content: [{ type: 'text', text: `No task "${id}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        // An explicit empty string clears the date; `undefined` leaves it. The
        // two are different intentions and a truthiness check would merge them.
        const nextDue = due === undefined ? existing.due : due === '' ? undefined : due;

        // `due` is pulled off `existing` rather than spread and overwritten,
        // because spreading cannot *remove* a key: `{ ...existing, ...{} }`
        // keeps the old date, which is precisely how clearing one silently
        // failed to clear it.
        const { due: _previous, ...rest } = existing;

        await writeTask(context.storage, {
          ...rest,
          title: title ?? existing.title,
          status: status ?? existing.status,
          tags: tags ?? existing.tags,
          ...(nextDue ? { due: nextDue } : {}),
          updatedAt: new Date().toISOString(),
          body: notes ?? existing.body,
        });

        context.audit.annotate({ task: id, from: existing.status, to: status ?? existing.status });

        return {
          content: [
            {
              type: 'text',
              text: `Updated task "${id}" on ${context.connection.key} — now ${status ?? existing.status}.`,
            },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'remove',
      title: 'Delete a task',
      description:
        'Remove a task and its notes. For something that was finished or decided against, prefer update with status done or dropped — deleting loses the record that it happened.',
      inputSchema: z.object({ id: z.string().min(1).describe('Task id') }),
      redact: keepKeys('id'),
      async handler({ id }, context) {
        const existed = await context.storage.has(taskKey(id));
        await context.storage.delete(taskKey(id));

        return {
          content: [
            {
              type: 'text',
              text: existed
                ? `Deleted task "${id}" from ${context.connection.key}.`
                : `No task "${id}" on ${context.connection.key}.`,
            },
          ],
          ...(existed ? {} : { isError: true }),
        };
      },
    },
  ],
});

/** One task as a document: the line a list would show, then the notes. */
function describe(task: Task): string {
  const header = [
    `# ${task.title}`,
    '',
    `status: ${task.status}`,
    ...(task.due ? [`due: ${task.due}`] : []),
    ...(task.tags.length > 0 ? [`tags: ${task.tags.join(', ')}`] : []),
    `updated: ${task.updatedAt}`,
  ];

  return task.body.length > 0 ? `${header.join('\n')}\n\n${task.body}` : header.join('\n');
}

export default tasksProvider;
