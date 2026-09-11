import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { missingFrom, nextAfterEdit } from './publish.ts';

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
    // Worded for a shrinking surface as well: `policy deny` prints this line,
    // and there is nothing to "pick up" after one.
    expect(line).not.toContain('pick them up');
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

/**
 * That "the endpoint reloaded" is not read as "the endpoint took this edit".
 *
 * The bug: `profile add` created a profile in a deployed workspace, the reload
 * answered `{reloaded: true, profiles: ["personal","projects"]}` without the new
 * name in it, and the command printed "Serving it now". `openReconciled` skips a
 * profile it cannot open rather than failing the endpoint for its siblings, so a
 * successful reload is exactly what a skipped profile looks like from here —
 * and `profiles` was not in the response cast, so the one field that says which
 * is which went unread.
 *
 * The endpoint side of this contract was already tested; the CLI side simply
 * never consumed it. Every test above builds a `PublishOutcome` by hand, which
 * is why none of them could have caught it.
 */
describe('a reload that left the edit out is not "served"', () => {
  test('a profile the endpoint did not open is reported missing', () => {
    expect(missingFrom(['personal', 'projects'], 'sandbox')).toEqual(['sandbox']);
  });

  test('a profile the endpoint opened is not', () => {
    expect(missingFrom(['personal', 'sandbox'], 'sandbox')).toEqual([]);
  });

  test('an edit touching several profiles names only the ones left out', () => {
    // `publishProfileEdit` passes `touched` for an edit that reached more than
    // the profile it named — the owner-layer repair is one — so this arrives as
    // a list as often as a string.
    expect(missingFrom(['a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['b', 'd']);
  });

  test('an endpoint that does not report its profiles is left alone', () => {
    // The compatibility case, and the reason this can only ever demote a claim
    // the endpoint actively contradicted. An endpoint from before `/reload`
    // carried `profiles` is what a workspace mid-upgrade is talking to, and
    // treating silence as "serving nothing" would report every edit as refused.
    expect(missingFrom(undefined, 'sandbox')).toEqual([]);
    expect(missingFrom('personal, projects', 'sandbox')).toEqual([]);
  });

  test('nothing is checked when the caller named no profile', () => {
    expect(missingFrom(['personal'], undefined)).toEqual([]);
  });

  test('a refused edit does not promise a restart will fix it', () => {
    // The wording that made this worth a field rather than just a reason: the
    // config *is* published, so the ordinary not-served tail — "the endpoint
    // will serve this when it next starts" — is true of a notify that could not
    // land and false of a reload that ran and refused. A restart re-runs the
    // same open and fails it the same way.
    const line = nextAfterEdit({
      served: false,
      refused: true,
      reason: 'the endpoint reloaded but is not serving "sandbox"',
      url: 'https://endpoint.example.com/reload',
    });

    expect(line).toContain('not serving "sandbox"');
    expect(line).not.toContain('when it next starts');
  });

  test('an endpoint that never answered still says the edit is safe', () => {
    const line = nextAfterEdit({ served: false, reason: 'no endpoint answered' });

    expect(line).toContain('when it next starts');
  });
});

/**
 * That an edit which records itself also tells the endpoint.
 *
 * The bug this exists for is a missing call, not a wrong one. `profile add`
 * wrote a profile into a deployed workspace's bucket and told nobody, so the
 * running revision — which lists the profiles at boot and at a reload and at no
 * other time — kept serving a set the operator had already added to. The
 * profile was durable and invisible at once, which reads exactly like a
 * dashboard that has not refreshed.
 *
 * The pattern was followed by seven commands and missed by this one, so a
 * hand-kept list of the seven would not have caught it: the list would have
 * been written from the code as it stood. `recordConfigChange` is the signal
 * instead, because it is the other half every config edit already performs —
 * a command that thinks the change is worth an audit entry thinks it is a
 * change, and a change the endpoint has not heard about is a stale endpoint.
 */
describe('a recorded config edit reaches the endpoint', () => {
  /**
   * Commands that record a change and deliberately do not publish one.
   *
   * Each needs an argument, not just an entry — an exception nobody has to
   * justify is how the gap above lasted as long as it did.
   */
  const EXCEPTIONS: Readonly<Record<string, string>> = {
    // The pairing credential is not in the generation. A deployed endpoint
    // reads it per request behind `cachedPairingCredential` and a loopback bind
    // reads it per request outright, so there is nothing held for a reload to
    // replace: `pair` changes a secret, not the config a generation was built
    // from.
    'commands/operate/pair.ts': 'the pairing credential is read per request, not held',
  };

  async function modules(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(join(import.meta.dir, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) found.push(...(await modules(path)));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
    }
    return found;
  }

  test('every command that records one publishes it, or says why not', async () => {
    const offenders: string[] = [];

    for (const path of await modules('commands')) {
      const source = await readFile(join(import.meta.dir, path), 'utf8');
      if (!source.includes('recordConfigChange(')) continue;
      if (source.includes("publish.ts'")) continue;
      if (path in EXCEPTIONS) continue;
      offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  test('the exceptions are still commands that record a change', async () => {
    // An exception for a file that stopped recording is dead, and dead
    // exceptions are how a list like this stops meaning anything.
    for (const path of Object.keys(EXCEPTIONS)) {
      const source = await readFile(join(import.meta.dir, path), 'utf8');
      expect(source).toContain('recordConfigChange(');
    }
  });
});
