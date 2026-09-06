import { describe, expect, test } from 'bun:test';
import { resolveWorkspaceRoot } from '#profile';
import { MANAGED_TARGET, environmentFor } from './workspace.ts';
import type { ControlAssertion } from './assertion.ts';

/**
 * How one process serves a request for one workspace.
 *
 * The obvious way is wrong and worth naming, because it is what a reader will
 * assume happened: setting `process.env.LANES_LINK_HOME` per request. A single
 * process handling concurrent requests cannot do that — the second request
 * overwrites the first mid-flight, and the failure is one workspace reading
 * another's configuration, which is the exact thing this component exists to
 * prevent.
 *
 * It does not have to. `resolveWorkspaceRoot` already takes an `env`, and
 * `resolveProfile` already threads one through. So a request carries its own,
 * explicitly, and `process.env` is never written.
 */

const caller = (workspace: string): ControlAssertion => ({
  subject: 'lanes:abc123',
  workspace,
  role: 'admin',
  scopes: ['link:admin'],
});

describe('the environment a request runs in', () => {
  test('names the workspace the assertion did', () => {
    const env = environmentFor(caller('ws-aaa'));
    expect(resolveWorkspaceRoot({ env })).toBe('lanes://ws-aaa');
  });

  test('gives two concurrent requests two different roots', () => {
    // The property that makes one process safe. Both envs exist at once and
    // neither is the other.
    const first = environmentFor(caller('ws-aaa'));
    const second = environmentFor(caller('ws-bbb'));

    expect(resolveWorkspaceRoot({ env: first })).toBe('lanes://ws-aaa');
    expect(resolveWorkspaceRoot({ env: second })).toBe('lanes://ws-bbb');
  });

  test('never writes the process environment', () => {
    const before = process.env['LANES_LINK_HOME'];
    environmentFor(caller('ws-aaa'));
    expect(process.env['LANES_LINK_HOME']).toBe(before);
  });

  test('overrides an ambient root rather than inheriting it', () => {
    // The container sets one for its own reasons. A request must not be served
    // from it, whatever it says.
    const env = environmentFor(caller('ws-aaa'), { LANES_LINK_HOME: 'gs://someone-elses-bucket' });
    expect(resolveWorkspaceRoot({ env })).toBe('lanes://ws-aaa');
  });

  test('keeps the rest of the environment, which other adapters read', () => {
    const env = environmentFor(caller('ws-aaa'), { SOMETHING_ELSE: 'kept' });
    expect(env['SOMETHING_ELSE']).toBe('kept');
  });

  test('names the target a managed workspace declares, so a command can select it', () => {
    expect(MANAGED_TARGET).toBe('managed');
  });
});
