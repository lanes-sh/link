import { describe, expect, test } from 'bun:test';
import { LANES_SCHEME } from '#deployments/adapters/lanes.ts';
import { READS, WIDENS, permits, workspaceRootFor } from './authorise.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * Who may do what, once the assertion has been believed.
 *
 * Three gates, and each answers a different question. The **role** says whether
 * this person may administer this workspace at all. The **scope** says what
 * they authorised *this client* to do on their behalf, ticked once when the
 * connector was added. Together they are what stops the chain ADR-007 exists to
 * prevent: an agent that can grant a profile access to a mailbox and then read
 * that mailbox through the endpoint.
 *
 * The third gate is a profile's own `agent_management` switch, which needs the
 * profile loaded and lives with the routes that load it.
 */

const caller = (over: Partial<ControlAssertion> = {}): ControlAssertion => ({
    subject: 'lanes:abc123',
    workspace: 'ws-aaa',
    role: 'admin',
    scopes: ['link:admin'],
    ...over,
});

describe('the workspace a call acts in', () => {
  test('comes from the assertion, and is a managed root', () => {
    expect(workspaceRootFor(caller({ workspace: 'ws-aaa' }))).toBe(`${LANES_SCHEME}ws-aaa`);
  });

  test('takes no argument but the assertion', () => {
    // The invariant the whole component rests on. `workspaceRootFor` is the
    // only way a route names a root, and its one parameter is the verified
    // statement — so there is no request body shape that can reach it, and a
    // prompt-injected agent has nothing to influence.
    expect(workspaceRootFor.length).toBe(1);
  });
});

describe('reading', () => {
  test('an editor may', () => {
    expect(permits(caller({ role: 'editor', scopes: [] }), READS)).toBeNull();
  });

  test('an admin may, since it ranks above editor', () => {
    expect(permits(caller({ role: 'admin', scopes: [] }), READS)).toBeNull();
  });

  test('needs no scope, because reading configuration authorises nothing', () => {
    expect(permits(caller({ role: 'editor', scopes: [] }), READS)).toBeNull();
  });
});

describe('widening what an agent can reach', () => {
  test('an admin holding the scope may', () => {
    expect(permits(caller(), WIDENS)).toBeNull();
  });

  test('an editor may not, whatever scope they hold', () => {
    const refusal = permits(caller({ role: 'editor' }), WIDENS);
    expect(refusal?.status).toBe(403);
    expect(refusal?.message).toMatch(/admin/);
  });

  test('an admin without the scope may not, and is told which scope', () => {
    // The case worth getting right. The person is an admin; what is missing is
    // that they never authorised *this client* to manage their configuration.
    // Saying so is the difference between a fixable setup step and a wall.
    const refusal = permits(caller({ scopes: [] }), WIDENS);
    expect(refusal?.status).toBe(403);
    expect(refusal?.message).toMatch(/link:admin/);
  });

  test('an unrelated scope is not the scope', () => {
    expect(permits(caller({ scopes: ['link:read', 'forms:write'] }), WIDENS)?.status).toBe(403);
  });
});

describe('a refusal', () => {
  test('says what would fix it rather than only what failed', () => {
    const refusal = permits(caller({ role: 'editor', scopes: [] }), WIDENS);
    // Both gates are unmet. Naming the role alone would send somebody to get
    // promoted and leave them refused for the other reason.
    expect(refusal?.message).toMatch(/admin/);
    expect(refusal?.message).toMatch(/link:admin/);
  });
});
