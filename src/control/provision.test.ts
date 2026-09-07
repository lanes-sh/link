import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SUPPORTED_CONTRACT, WORKSPACE_FILE, workspaceSchema } from '#profile';
import { ensureManagedWorkspace } from './provision.ts';

/**
 * A hosted workspace writing its own registry the first time it is used.
 *
 * Before this there was no code path anywhere that wrote `workspaces.yaml` for
 * a managed workspace: it could be addressed, it read as empty, and the first
 * `POST /v1/profiles` failed on a registry with no `managed` target in it. The
 * dashboard had a working Add profile button pointed at a workspace that could
 * not accept one.
 *
 * A filesystem root here rather than a `lanes://` one, because what is under
 * test is the document and the idempotence — which adapter the bytes go through
 * is `lanes.test.ts`'s subject and `workspaceFiles`'s decision.
 */

const roots: string[] = [];

async function root(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'lanes-provision-'));
  roots.push(made);
  return made;
}

afterEach(async () => {
  for (const one of roots.splice(0)) await rm(one, { recursive: true, force: true });
});

async function registry(at: string): Promise<unknown> {
  return parseYaml(await readFile(join(at, WORKSPACE_FILE), 'utf8'));
}

describe('a hosted workspace on first use', () => {
  test('writes a registry the loader accepts', async () => {
    const at = await root();

    expect(await ensureManagedWorkspace(at, 'ws-aaa', {})).toBe(true);

    // Through the real schema, not by eye. A document this file hand-writes as
    // text is exactly the kind that parses in a test and fails in the loader.
    const parsed = workspaceSchema.safeParse(await registry(at));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.contract).toBe(SUPPORTED_CONTRACT);
  });

  test('declares the managed target, addressed at this workspace', async () => {
    const at = await root();
    await ensureManagedWorkspace(at, 'ws-aaa', {});

    const parsed = workspaceSchema.parse(await registry(at));
    const target = parsed.workspaces['managed'];

    expect(target).toBeDefined();
    expect(target?.storage).toEqual({ adapter: 'lanes', workspace: 'ws-aaa' });
    // The namespace is what keeps one tenant's `tokens/tok1` from being
    // another's: every workspace stores the same reference names, and they
    // share a Secret Manager project.
    expect(target?.credentials?.namespace).toBe('ws-aaa');
    expect(parsed.default_workspace).toBe('managed');
  });

  test('names the Secret Manager project when the process has one', async () => {
    const at = await root();
    await ensureManagedWorkspace(at, 'ws-aaa', { LANES_RUNTIME_SECRET_PROJECT: 'my-project' });

    const parsed = workspaceSchema.parse(await registry(at));
    expect(parsed.workspaces['managed']?.credentials?.project).toBe('my-project');
  });

  test('writes a usable registry without one, because configuration needs no secrets', async () => {
    // The local case. Profiles, grants and members never open the secret store,
    // so a workspace with no project is fully configurable; it is connecting an
    // account that needs it, and `openSecrets` refuses that by name rather than
    // failing here where nothing is wrong yet.
    const at = await root();
    await ensureManagedWorkspace(at, 'ws-aaa', {});

    const parsed = workspaceSchema.safeParse(await registry(at));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.workspaces['managed']?.credentials?.project).toBeUndefined();
  });

  test('does nothing on every call after the first', async () => {
    const at = await root();
    expect(await ensureManagedWorkspace(at, 'ws-aaa', {})).toBe(true);
    expect(await ensureManagedWorkspace(at, 'ws-aaa', {})).toBe(false);
  });

  test('does not overwrite a registry somebody has since edited', async () => {
    // The reason the check is `has` and not "does it look right". A workspace
    // that has been changed — a vault block, a second target — is not one to
    // reset to the skeleton because a field moved.
    const at = await root();
    await ensureManagedWorkspace(at, 'ws-aaa', {});

    const before = await readFile(join(at, WORKSPACE_FILE), 'utf8');
    const edited = `${before}# somebody was here\n`;
    await Bun.write(join(at, WORKSPACE_FILE), edited);

    expect(await ensureManagedWorkspace(at, 'ws-aaa', {})).toBe(false);
    expect(await readFile(join(at, WORKSPACE_FILE), 'utf8')).toBe(edited);
  });

  test('two calls racing write the same document', async () => {
    // Both see no file and both write, which is safe precisely because the
    // bytes do not depend on which won. Worth pinning: the day the skeleton
    // grows something generated — a timestamp, an id — this stops being true
    // and the race needs a lock.
    const at = await root();
    const [first, second] = await Promise.all([
      ensureManagedWorkspace(at, 'ws-aaa', {}),
      ensureManagedWorkspace(at, 'ws-aaa', {}),
    ]);

    expect([first, second].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(workspaceSchema.safeParse(await registry(at)).success).toBe(true);
  });

  test('the document explains itself, because somebody will read it', async () => {
    const at = await root();
    await ensureManagedWorkspace(at, 'ws-aaa', {});
    const text = await readFile(join(at, WORKSPACE_FILE), 'utf8');

    // Specifically that there was no step they skipped. Somebody opening this
    // file is working out what Lanes holds for them, and a bare three keys
    // answers none of it.
    expect(text).toContain('There was no step you');
    // Wrapped across a line, so matched on a fragment that cannot be: the point
    // is that the file says it, not where the wrap falls.
    expect(text).toContain('nothing to');
    expect(text).toContain('# enable and nothing to create.');
  });
});
