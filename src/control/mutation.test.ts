import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '#profile';
import { createProfile } from '#cli/commands/profile.ts';
import { agentMayManage } from './authorise.ts';

/**
 * Changing a workspace's configuration from somewhere that is not a terminal.
 *
 * Two things have to be true before a mutation can run at all, and both are
 * plumbing rather than policy — the policy is the role and the scope, already
 * in `authorise.ts`.
 *
 * **A command has to accept the workspace it acts on.** Every CLI command
 * resolves `resolveWorkspaceRoot()` from the process environment, which is
 * exactly right for a terminal — a terminal has one workspace in view — and
 * unusable in a process serving many concurrently. The parameter already exists
 * one layer down; what is missing is the commands passing it through.
 *
 * **A profile can refuse to be changed by an agent.** The role says who you
 * are and the scope says what you authorised this client to do; neither says
 * anything about *this* profile. Somebody who keeps personal mail in one
 * profile and work in another wants the first one closed to agents whatever
 * their own role is.
 */

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'lanes-control-'));
}

describe('a command that acts on a named workspace', () => {
  test('writes into the root its environment names, not the process one', async () => {
    const root = await scratch();
    try {
      const created = await createProfile('work', {
        targets: ['local'],
        nonInteractive: true,
        env: { LANES_LINK_HOME: root },
      });

      expect(created.path.startsWith(root)).toBe(true);
      // And it is a profile the loader accepts, rather than merely a file.
      const text = await readFile(created.path, 'utf8');
      expect(text).toContain('profile: work');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('two roots in one process do not collide', async () => {
    // The property that makes a mutation safe in a multi-tenant process. Both
    // calls run against the same `process.env`; only the argument differs.
    const [first, second] = [await scratch(), await scratch()];
    try {
      const a = await createProfile('personal', {
        targets: ['local'],
        nonInteractive: true,
        env: { LANES_LINK_HOME: first },
      });
      const b = await createProfile('personal', {
        targets: ['local'],
        nonInteractive: true,
        env: { LANES_LINK_HOME: second },
      });

      expect(a.path.startsWith(first)).toBe(true);
      expect(b.path.startsWith(second)).toBe(true);
      expect(a.path).not.toBe(b.path);
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
});

describe('a profile that refuses to be changed by an agent', () => {
  const profile = (agent_management?: string) =>
    configSchema.parse({
      contract: 5,
      instance: { profile: 'personal' },
      grants: [],
      members: [],
      ...(agent_management ? { agent_management } : {}),
    });

  test('arrives open, because a dashboard-optional workspace is the point', () => {
    expect(profile().agent_management).toBe('allow');
    expect(agentMayManage(profile())).toBe(true);
  });

  test('can be closed, and then refuses', () => {
    expect(agentMayManage(profile('deny'))).toBe(false);
  });

  test('refuses anything that is not one of the two spellings', () => {
    // Not a boolean and not free text: a third value arriving from a newer
    // release must fail loudly here rather than being read as permission.
    expect(() => profile('maybe')).toThrow();
    expect(() => profile('true')).toThrow();
  });
});
