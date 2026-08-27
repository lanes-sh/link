import { describe, expect, test } from 'bun:test';
import { isResourceListResult, isResourceResult, isToolResult } from '#connectivity';
import { tasksProvider } from './provider.ts';
import { TASK_STATUSES, parseTask } from './store.ts';
import { harnessFor, linksOf, textOf } from '../harness.ts';

/**
 * Tasks.
 *
 * The property this file exists to hold is the one that makes this provider not
 * be memory: **a task has a status, and closing one keeps the record**. Around
 * that, the same two things memory's tests hold — reading and writing are
 * different capabilities, and a task is one Markdown file with no index.
 */

function tasks() {
  return harnessFor(tasksProvider);
}

async function add(
  harness: ReturnType<typeof tasks>,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return harness.invoke('add', { title, ...extra });
}

describe('a task carries a status, which is why this is not memory', () => {
  test('a new task is open, and closing it is an update rather than a delete', async () => {
    const harness = tasks();
    await add(harness, 'Chase the invoice');

    expect(textOf(await harness.invoke('get', { id: 'chase-the-invoice' }))).toContain(
      'status: open',
    );

    await harness.invoke('update', { id: 'chase-the-invoice', status: 'done' });

    const after = await harness.invoke('get', { id: 'chase-the-invoice' });
    expect(isToolResult(after) && after.isError).toBeFalsy();
    expect(textOf(after)).toContain('status: done');
  });

  test('list shows outstanding work and hides what is finished or muted', async () => {
    const harness = tasks();
    await add(harness, 'Still open');
    await add(harness, 'Being done', { status: 'in_progress' });
    await add(harness, 'Waiting', { status: 'blocked' });
    await add(harness, 'Not now', { status: 'muted' });
    await add(harness, 'Finished', { status: 'done' });
    await add(harness, 'Abandoned', { status: 'dropped' });

    const listed = textOf(await harness.invoke('list'));

    expect(listed).toContain('Still open');
    expect(listed).toContain('Being done');
    expect(listed).toContain('Waiting');
    expect(listed).not.toContain('Not now');
    expect(listed).not.toContain('Finished');
    expect(listed).not.toContain('Abandoned');
  });

  test('naming a status overrides that, including for muted work', async () => {
    const harness = tasks();
    await add(harness, 'Not now', { status: 'muted' });

    expect(textOf(await harness.invoke('list', { status: ['muted'] }))).toContain('Not now');
  });

  test('in_progress sorts before open, and a due date before none', async () => {
    const harness = tasks();
    await add(harness, 'Open undated');
    await add(harness, 'Open late', { due: '2026-12-01' });
    await add(harness, 'Open soon', { due: '2026-09-01' });
    await add(harness, 'Started', { status: 'in_progress' });

    const order = linksOf(await harness.invoke('list')).map((uri) =>
      uri.replace('tasks://task/', ''),
    );

    expect(order).toEqual(['started', 'open-soon', 'open-late', 'open-undated']);
  });

  test('every declared status is accepted', async () => {
    const harness = tasks();

    for (const status of TASK_STATUSES) {
      const result = await harness.invoke('add', { title: `A ${status} thing`, status });
      expect(isToolResult(result) && result.isError).toBeFalsy();
    }
  });
});

describe('storing and retrieving a task', () => {
  test('a task is addressable as a resource', async () => {
    const harness = tasks();
    await add(harness, 'Chase the invoice', { notes: 'Third reminder.' });

    const read = await harness.invoke('task', { uri: 'tasks://task/chase-the-invoice' });

    expect(isResourceResult(read)).toBe(true);
    expect(textOf(read)).toContain('Third reminder.');
  });

  test('the id derives from the title, and may be given instead', async () => {
    const harness = tasks();
    await add(harness, 'A Long: Title!');
    await add(harness, 'Anything', { id: 'chosen' });

    expect(isResourceResult(await harness.invoke('task', { uri: 'tasks://task/a-long-title' }))).toBe(
      true,
    );
    expect(isResourceResult(await harness.invoke('task', { uri: 'tasks://task/chosen' }))).toBe(true);
  });

  test('adding the same id again replaces it but keeps when it was first recorded', async () => {
    const harness = tasks();
    await add(harness, 'Note', { id: 'note', notes: 'first' });
    const created = firstCreatedAt(await documentFor(harness, 'note'));

    await add(harness, 'Note', { id: 'note', notes: 'second' });
    const document = await documentFor(harness, 'note');

    expect(document).toContain('second');
    expect(document).not.toContain('first');
    expect(firstCreatedAt(document)).toBe(created);

    const listed = await harness.invoke('task');
    expect(isResourceListResult(listed) && listed.resources).toHaveLength(1);
  });

  test('a task is one Markdown file, and nothing else', async () => {
    const harness = tasks();
    await add(harness, 'Chase the invoice', { tags: ['billing'], due: '2026-09-01' });

    const keys = (await harness.context.storage.list()).map((blob) => blob.key);
    expect(keys).toEqual(['chase-the-invoice.md']);

    const document = await documentFor(harness, 'chase-the-invoice');
    expect(document).toStartWith('---\n');
    expect(document).toContain('status: open');
    expect(document).toContain('due: ');
    expect(document).toContain('billing');
  });

  test('a plain Markdown file dropped in the directory reads as an open task', async () => {
    const harness = tasks();
    await harness.context.storage.put(
      'hand-written.md',
      new TextEncoder().encode('Something I typed myself.\n'),
    );

    const listed = textOf(await harness.invoke('list'));
    expect(listed).toContain('hand-written');
    expect(listed).toContain('open');
  });

  test('an unrecognised status reads as open rather than breaking the listing', () => {
    const task = parseTask('x', '---\ntitle: X\nstatus: sideways\n---\n\nbody\n', 'when');
    expect(task.status).toBe('open');
  });
});

describe('changing a task', () => {
  test('omitted fields are left alone', async () => {
    const harness = tasks();
    await add(harness, 'Original', { id: 't', notes: 'keep me', tags: ['a'], due: '2026-09-01' });

    await harness.invoke('update', { id: 't', status: 'in_progress' });

    const document = await documentFor(harness, 't');
    expect(document).toContain('title: Original');
    expect(document).toContain('keep me');
    expect(document).toContain('due: ');
    expect(document).toContain('status: in_progress');
  });

  test('an empty due clears it, where omitting it would not', async () => {
    const harness = tasks();
    await add(harness, 'Dated', { id: 't', due: '2026-09-01' });

    await harness.invoke('update', { id: 't', due: '' });
    expect(await documentFor(harness, 't')).not.toContain('due:');
  });

  test('updating something that is not there is an error, not a create', async () => {
    const harness = tasks();
    const result = await harness.invoke('update', { id: 'nope', status: 'done' });

    expect(isToolResult(result) && result.isError).toBe(true);
    expect((await harness.context.storage.list()).map((blob) => blob.key)).toEqual([]);
  });

  test('the status change is what reaches the audit log, not the words', async () => {
    const harness = tasks();
    await add(harness, 'Secret sounding title', { id: 't' });
    await harness.invoke('update', { id: 't', status: 'done', notes: 'private detail' });

    const annotations = harness.annotations();
    expect(annotations).toMatchObject({ task: 't', from: 'open', to: 'done' });
    expect(JSON.stringify(annotations)).not.toContain('private detail');
  });
});

describe('reading and writing are different capabilities — ADR-012 §2', () => {
  test('the default bundle reads and does not write', () => {
    const bundles = tasksProvider.manifest.bundles ?? [];
    const read = bundles.find((bundle) => bundle.default);

    expect(read?.name).toBe('read');
    expect(read?.capabilities).toEqual(['task', 'list', 'get']);
    expect(read?.capabilities).not.toContain('add');
  });

  test('every write is in the non-default bundle', () => {
    const bundles = tasksProvider.manifest.bundles ?? [];
    const write = bundles.find((bundle) => bundle.name === 'write');

    expect(write?.default).toBeFalsy();
    expect(write?.capabilities.sort()).toEqual(['add', 'remove', 'update']);
  });
});

async function documentFor(harness: ReturnType<typeof tasks>, id: string): Promise<string> {
  const bytes = await harness.context.storage.get(`${id}.md`);
  expect(bytes).not.toBeNull();
  return new TextDecoder().decode(bytes!);
}

function firstCreatedAt(document: string): string {
  return /created_at: (.*)/.exec(document)?.[1] ?? '';
}
