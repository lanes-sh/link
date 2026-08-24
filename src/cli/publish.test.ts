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

  test('a served edit says what the surface is now, and how a client picks it up', () => {
    // The failure this wording exists for: the endpoint re-read its config and
    // said so, the operator refreshed their connector, and the connector went
    // on showing the two tools it captured before any account was connected.
    // Nothing was wrong with the endpoint — the client had never been told to
    // ask again, and cannot be, so the command has to say it.
    const line = nextAfterEdit({ served: true, tools: 42 });

    expect(line).toContain('Serving it now');
    expect(line).toContain('42 tools');
    expect(line).toContain('reconnect');
  });

  test('an endpoint that did not report a count says only what it knows', () => {
    // An older endpoint, or one behind a proxy that ate the body. Inventing a
    // number here would be worse than omitting the sentence.
    expect(nextAfterEdit({ served: true })).not.toContain('reconnect');
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
