import type { BlobStore } from '#connectivity';
import {
  splitOptionalFrontmatter,
  stringList,
  withFrontmatter,
} from '#providers/shared/frontmatter.ts';
import { slugify as slugifyText } from '#providers/shared/slug.ts';

/**
 * How a task is stored, and the only place that knows.
 *
 * **One task is one Markdown file**, exactly as a memory entry is, and for the
 * same reason: `lanes link tasks` and a text editor reach the same bytes, and
 * there is no index row that can disagree with the file it describes. ADR-014
 * reversed that split for memory and there is no argument for reintroducing it
 * here. The document is frontmatter — title, status, tags, due, timestamps —
 * above a body that is the notes.
 *
 * Its own file rather than living in `provider.ts` because the CLI needs it too
 * (`lanes link tasks list` reads these bytes) and because the two together
 * would pass the file-size budget. The seam is the one `skills/` already uses:
 * this knows the format, the provider knows the capabilities.
 *
 * The store arrives scoped to `tasks/<connection>` by core, so nothing here
 * prefixes a key or thinks about isolation — one connection's tasks are not
 * addressable from another because of where the store was cut, not because of
 * anything written below.
 */

/**
 * The statuses, in the order a list should show them.
 *
 * Six rather than three, and each earns its place by being a different answer
 * to "why is this not done":
 *
 *   in_progress  started, and the thing to pick back up first
 *   open         not started
 *   blocked      waiting on something that is not the owner
 *   muted        deliberately not being surfaced — a real state, and the one
 *                asked for by name. Distinct from `blocked`: blocked is waiting
 *                on the world, muted is a decision to stop being reminded.
 *   done         finished
 *   dropped      decided against, which is not the same fact as finished and
 *                should not be recorded as one
 *
 * The order is the sort order, which is why it is a tuple rather than a set.
 */
export const TASK_STATUSES = [
  'in_progress',
  'open',
  'blocked',
  'muted',
  'done',
  'dropped',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The statuses `tasks.list` shows unless asked otherwise. See `provider.ts`. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['in_progress', 'open', 'blocked'];

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly tags: readonly string[];
  /**
   * As the owner wrote it — `2026-08-27` or a full instant — never normalised.
   *
   * Normalising would have to invent a time zone: "Friday" recorded as an
   * instant is a different day in two places, and what was typed was a day.
   * `compareTasks` orders these as strings, which is correct for any ISO-8601
   * prefix and is the only ordering claim made about them.
   */
  readonly due?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
}

const TASK_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function taskKey(id: string): string {
  return `${id}.md`;
}

export function idFromKey(key: string): string | null {
  if (!key.endsWith('.md')) return null;
  const id = key.slice(0, -'.md'.length);
  return TASK_ID.test(id) ? id : null;
}

export function assertTaskId(id: string): void {
  if (!TASK_ID.test(id)) {
    throw new Error(
      `Task id ${JSON.stringify(id)} must be lowercase letters, digits, "_" or "-".`,
    );
  }
}

/** A stable id from a title, so adding a task does not demand one be invented. */
export function slugify(title: string): string {
  return slugifyText(title, 'task');
}

/**
 * Parse one stored task, tolerating anything.
 *
 * Every field falls back, and none of the fallbacks is an error, because this
 * reads a directory the owner is invited to edit. A plain Markdown file dropped
 * in there is an open task titled after its filename — which is a better answer
 * than an exception that hides every other task behind it. An unrecognised
 * `status` reads as `open` for the same reason: the useful failure is a task in
 * the wrong column, not a listing that will not render.
 */
export function parseTask(id: string, text: string, fallbackUpdatedAt: string): Task {
  const { frontmatter, body } = splitOptionalFrontmatter(text);

  const title = frontmatter['title'];
  const status = frontmatter['status'];
  const due = frontmatter['due'];
  const createdAt = frontmatter['created_at'];
  const updatedAt = frontmatter['updated_at'];

  return {
    id,
    title: typeof title === 'string' && title.trim().length > 0 ? title : id,
    status: readStatus(status),
    tags: stringList(frontmatter['tags']),
    ...(typeof due === 'string' && due.trim().length > 0 ? { due } : {}),
    createdAt: typeof createdAt === 'string' ? createdAt : fallbackUpdatedAt,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : fallbackUpdatedAt,
    body: body.trimEnd(),
  };
}

/** An unrecognised status is `open`, not an error. See `parseTask`. */
function readStatus(raw: unknown): TaskStatus {
  return typeof raw === 'string' && (TASK_STATUSES as readonly string[]).includes(raw)
    ? (raw as TaskStatus)
    : 'open';
}

export function serialiseTask(task: Omit<Task, 'id'>): string {
  return withFrontmatter(
    {
      title: task.title,
      status: task.status,
      ...(task.tags.length > 0 ? { tags: [...task.tags] } : {}),
      ...(task.due ? { due: task.due } : {}),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    },
    `${task.body.trimEnd()}\n`,
  );
}

export async function readTask(storage: BlobStore, id: string): Promise<Task | null> {
  const bytes = await storage.get(taskKey(id));
  if (bytes === null) return null;

  return parseTask(id, new TextDecoder().decode(bytes), new Date(0).toISOString());
}

export async function writeTask(storage: BlobStore, task: Task): Promise<void> {
  const { id: _id, ...rest } = task;
  await storage.put(taskKey(task.id), new TextEncoder().encode(serialiseTask(rest)), {
    contentType: 'text/markdown',
  });
}

/**
 * How many tasks are read at once.
 *
 * The bound memory uses, for the reason memory gives: against a bucket each
 * read is an HTTPS request, and firing four hundred at once trades a slow list
 * for a rate-limited one.
 */
const READ_CONCURRENCY = 16;

/**
 * Every task, in the order a list wants them.
 *
 * One pass over all of them, and honest about it — the metadata a listing needs
 * is inside each document, so there is nothing cheaper to consult. That is the
 * cost of one file per task and it is the same trade memory makes.
 */
export async function allTasks(storage: BlobStore): Promise<Task[]> {
  const blobs = (await storage.list()).flatMap((blob) => {
    const id = idFromKey(blob.key);
    return id === null ? [] : [{ blob, id }];
  });

  const tasks: Task[] = [];

  for (let start = 0; start < blobs.length; start += READ_CONCURRENCY) {
    const batch = await Promise.all(
      blobs.slice(start, start + READ_CONCURRENCY).map(async ({ blob, id }) => {
        const bytes = await storage.get(blob.key);
        return bytes === null
          ? null
          : parseTask(id, new TextDecoder().decode(bytes), blob.modifiedAt.toISOString());
      }),
    );
    for (const task of batch) if (task) tasks.push(task);
  }

  return tasks.sort(compareTasks);
}

/**
 * Status, then due date, then most recently touched.
 *
 * Not memory's plain `updatedAt` descending, because a task list is read to
 * decide what to do next and the most recently *edited* task is rarely that.
 * Undated sorts after dated within a status: a task with a date is making a
 * claim about when, and one without is not, so the claim goes first.
 */
export function compareTasks(a: Task, b: Task): number {
  const rank = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
  if (rank !== 0) return rank;

  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  }

  return b.updatedAt.localeCompare(a.updatedAt);
}

/** The pieces `lanes link tasks` needs to reach the same bytes the provider does. */
export const taskStorage = {
  key: taskKey,
  idFromKey,
  parse: parseTask,
  serialise: serialiseTask,
  read: readTask,
  write: writeTask,
  all: allTasks,
  compare: compareTasks,
  slugify,
};
