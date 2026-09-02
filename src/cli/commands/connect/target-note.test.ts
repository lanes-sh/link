import { describe, expect, test } from 'bun:test';
import type { Resolution } from '#profile';
import { announceConnectTarget } from './target-note.ts';

/**
 * Where `connect` says it is writing, and when it warns that you meant elsewhere.
 *
 * Testable without a runtime, a config file, or a credential store — which is
 * the reason this wording lives beside `outcome.ts` rather than inside the five
 * steps. The condition being pinned down here is the one that decides whether an
 * operator ever reads the line: a warning that fires on every local `connect`
 * gets tuned out long before the one deploy it was written for.
 */

function captured(body: () => void): { out: string; err: string } {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string) => ((out += chunk), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string) => ((err += chunk), true);

  try {
    body();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = outWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = errWrite;
  }

  return { out, err };
}

describe('announcing the target', () => {
  const resolution: Resolution = {
    workspaceRoot: '/tmp/workspace',
    profile: 'personal',
    profilePath: '/tmp/workspace/profiles/personal/profile.yaml',
    target: 'local',
  };

  test('writes nothing to stdout for a --json caller', () => {
    // The assertion is the parse. `emit` guards the lines printed at the emit,
    // and this one precedes the browser — so it carries its own guard, and a
    // stray line here would corrupt the document a caller is parsing.
    const { out } = captured(() => {
      announceConnectTarget({ resolution }, true);
      process.stdout.write(JSON.stringify({ ok: true }));
    });

    expect(() => JSON.parse(out)).not.toThrow();
  });

  test('names the profile and the target it is about to write into', () => {
    const { out } = captured(() => announceConnectTarget({ resolution }, false));

    expect(out).toContain('personal');
    expect(out).toContain('local');
  });

  test('goes to stdout, where every other command puts its announce', () => {
    const { out, err } = captured(() => announceConnectTarget({ resolution }, false));

    expect(out).not.toBe('');
    expect(err).toBe('');
  });
});
