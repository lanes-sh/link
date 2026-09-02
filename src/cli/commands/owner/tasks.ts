import { ConfigError } from '#profile';
import { scopeNamespace } from '#dispatch';
import { scopeBlobStore, type BlobStore } from '#stores/blobs';
import { ACTIVE_STATUSES, TASK_STATUSES, taskStorage, type TaskStatus } from '#providers/owner.ts';
import { heading, ok, print, style, table } from '../../output.ts';
import type { Runtime } from '../../runtime.ts';
import {
  agreed,
  optionalStdin,
  ownerConnection,
  required,
  withRuntime,
  type OwnerFlags,
} from './shared.ts';

/** `lanes link tasks` — what the owner has to do. */

export async function tasksList(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const store = tasksStore(runtime, flags);

    // The same default the `tasks.list` capability applies, and for the same
    // reason: the question is what is outstanding, and a list that grows forever
    // is one nobody reads. `--status all` is the escape hatch.
    const wanted = statusFilter(flags.status);
    const tasks = (await taskStorage.all(store)).filter(
      (task) =>
        (wanted === null || wanted.has(task.status)) && (!flags.tag || task.tags.includes(flags.tag)),
    );

    heading(`Tasks (${tasks.length}${wanted === null ? '' : ' outstanding'})`);
    if (tasks.length === 0) {
      print(style.dim('  none — add one with: lanes link tasks add <title>'));
      return;
    }

    table(
      tasks.map((task) => [
        `  ${task.id}`,
        task.status,
        task.title,
        task.due ? style.dim(`due ${task.due}`) : '',
        task.tags.length > 0 ? style.dim(task.tags.join(', ')) : '',
      ]),
    );
  });
}

export async function tasksGet(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const taskId = required(id, 'lanes link tasks get <id>');

  await withRuntime(flags, async (runtime) => {
    const task = await taskStorage.read(tasksStore(runtime, flags), taskId);
    if (!task) throw new ConfigError(`No task "${taskId}" in this profile.`);

    print('');
    print(`  ${style.bold(task.title)}`);
    print(style.dim(`  ${task.status}${task.due ? `  due ${task.due}` : ''}`));
    if (task.tags.length > 0) print(style.dim(`  ${task.tags.join(', ')}`));
    if (task.body.length > 0) {
      print('');
      print(task.body);
    }
  });
}

/**
 * `lanes link tasks add <title>` — the title on argv, notes optional on stdin.
 *
 * Unlike `memory write`, the title is the argument and the body is optional: a
 * task is usually one line, and demanding a heredoc to write "chase the invoice"
 * would make the common case the awkward one. So `optionalStdin` rather than
 * `readStdin` — see its docstring for what refusing an empty pipe here broke.
 */
export async function tasksAdd(title: string | undefined, flags: OwnerFlags): Promise<void> {
  const given = required(title, 'lanes link tasks add <title>   (notes on stdin, optional)');
  const notes = await optionalStdin();

  await withRuntime(flags, async (runtime) => {
    const store = tasksStore(runtime, flags);
    const id = taskStorage.slugify(given);
    const existing = await taskStorage.read(store, id);
    const now = new Date().toISOString();

    await taskStorage.write(store, {
      id,
      title: given,
      status: assertStatus(flags.status) ?? 'open',
      tags: flags.tag ? [flags.tag] : (existing?.tags ?? []),
      ...(flags.due ? { due: flags.due } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      body: notes,
    });

    print(ok(`${existing ? 'replaced' : 'added'} task ${style.bold(id)}`));
  });
}

/**
 * `lanes link tasks update <id> --status done`.
 *
 * Omitted flags leave their fields alone, which is what makes this the way to
 * close a task rather than delete it: the record of having done it is the useful
 * part, and `--status done` keeps everything else.
 */
export async function tasksUpdate(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const taskId = required(id, 'lanes link tasks update <id> --status <status>');

  await withRuntime(flags, async (runtime) => {
    const store = tasksStore(runtime, flags);
    const existing = await taskStorage.read(store, taskId);
    if (!existing) throw new ConfigError(`No task "${taskId}" in this profile.`);

    const status = assertStatus(flags.status);
    if (!status && !flags.title && !flags.due && !flags.tag) {
      throw new ConfigError(
        `Nothing to change. Pass --status, --title, --due or --tag.\n` +
          `  statuses: ${TASK_STATUSES.join(', ')}`,
      );
    }

    // `due` is taken off the existing record rather than spread and overwritten,
    // because spreading cannot remove a key — the same trap the provider's
    // `update` documents.
    const { due: previous, ...rest } = existing;
    const due = flags.due === '' ? undefined : (flags.due ?? previous);

    await taskStorage.write(store, {
      ...rest,
      title: flags.title ?? existing.title,
      status: status ?? existing.status,
      tags: flags.tag ? [flags.tag] : existing.tags,
      ...(due ? { due } : {}),
      updatedAt: new Date().toISOString(),
    });

    print(ok(`updated task ${style.bold(taskId)} — now ${status ?? existing.status}`));
  });
}

export async function tasksRemove(id: string | undefined, flags: OwnerFlags): Promise<void> {
  const taskId = required(id, 'lanes link tasks remove <id>');

  await withRuntime(flags, async (runtime) => {
    const store = tasksStore(runtime, flags);
    const task = await taskStorage.read(store, taskId);
    if (!task) throw new ConfigError(`No task "${taskId}" in this profile.`);

    print(`  ${style.bold(task.id)}  ${task.status}  ${task.title}`);
    print(
      style.dim('  deleting loses the record that it happened — "update --status done" keeps it'),
    );
    if (!(await agreed(flags, 'Delete this task?'))) return;

    await store.delete(taskStorage.key(taskId));
    print(ok(`deleted task ${style.bold(taskId)}`));
  });
}

/**
 * `--status` as a filter: a named one, `all`, or the outstanding set by default.
 *
 * `null` means every status. Returning a set rather than a predicate so the
 * heading can say whether it narrowed.
 */
function statusFilter(raw: string | undefined): Set<TaskStatus> | null {
  if (raw === 'all') return null;
  if (raw === undefined) return new Set(ACTIVE_STATUSES);
  return new Set([assertStatus(raw)!]);
}

function assertStatus(raw: string | undefined): TaskStatus | undefined {
  if (raw === undefined) return undefined;
  if (!(TASK_STATUSES as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `Unknown status "${raw}". One of: ${TASK_STATUSES.join(', ')}` +
        '\n  (or "all", when filtering a listing)',
    );
  }
  return raw as TaskStatus;
}

/**
 * The blob namespace core would scope this provider to.
 *
 * Built from `scopeNamespace` and `scopeBlobStore` — the same two functions
 * `buildProviderContext` uses — rather than from a path spelled out again, so the
 * CLI cannot address a different directory from the provider.
 */
export function tasksStore(runtime: Runtime, flags: OwnerFlags): BlobStore {
  const connection = ownerConnection(runtime.config, 'lanes_tasks', flags);
  return scopeBlobStore(runtime.storage, scopeNamespace('lanes_tasks', connection));
}
