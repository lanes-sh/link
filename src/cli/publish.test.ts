import { describe, expect, test } from 'bun:test';
import { nextAfterEdit } from './publish.ts';

/**
 * The line an edit ends on.
 *
 * It used to be a guess derived from whether the target was deployable —
 * "restart it" or "roll a revision". It reports now, which means the wording
 * has to carry the one case that is easy to misread: nothing answered, but the
 * edit is safe (ADR-029).
 */
describe('what an edit says it did', () => {
  test('a served edit needs nothing further', () => {
    const line = nextAfterEdit({ served: true });

    expect(line).toContain('Serving it now');
    expect(line).not.toContain('restart');
    expect(line).not.toContain('deploy');
  });

  test('an unreachable endpoint names where it tried', () => {
    // `lanes link start --port 7455` moves the socket without moving
    // `instance.port`, so "nothing answered" most often means "not there".
    const line = nextAfterEdit({
      served: false,
      url: 'http://127.0.0.1:7337/reload',
      reason: 'no endpoint answered',
    });

    expect(line).toContain('http://127.0.0.1:7337/reload');
    expect(line).toContain('when it next starts');
  });

  test('a failure never suggests a redeploy', () => {
    // Rolling a revision is how code gets to an endpoint, and an edit that
    // could not be delivered changed no code.
    for (const reason of ['no endpoint answered', 'the endpoint answered 503']) {
      expect(nextAfterEdit({ served: false, reason })).not.toContain('deploy');
    }
  });

  test('a publish failure is reported rather than swallowed', () => {
    const line = nextAfterEdit({
      served: false,
      reason: 'could not publish the config to this target: bucket not found',
    });

    expect(line).toContain('could not publish');
    expect(line).toContain('bucket not found');
  });
});
