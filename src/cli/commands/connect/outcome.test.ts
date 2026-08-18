import { describe, expect, test } from 'bun:test';
import { progress } from '../../output.ts';
import { ALREADY, NOTHING, RESTART, renderOutcome, nextAfterConnect } from './outcome.ts';

/**
 * What a caller is told when `connect` stops short.
 *
 * The refusal is the product in that case, so it has to carry the command that
 * ends it. And it has to carry it on **stdout**, while every note printed on the
 * way there goes to stderr — that split is what lets `--json` stay parseable
 * without each intermediate step having to know whether anyone is parsing.
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

describe('progress', () => {
  test('goes to stderr, so a JSON stdout survives a narrated command', () => {
    const { out, err } = captured(() => progress('Discovering capabilities…'));

    expect(out).toBe('');
    expect(err).toContain('Discovering capabilities…');
  });
});

describe('a blocked outcome', () => {
  test('prints the value it wants and the command that stores it', () => {
    const { out } = captured(() =>
      renderOutcome({
        ...NOTHING,
        ok: false,
        reason: 'missing_credentials',
        message: 'Post needs 1 value(s) in the credential store first.',
        needs: [
          {
            ref: 'post/will',
            label: 'Account, then App password',
            secret: true,
            scope: 'connection',
            prompts: ['username', 'password'],
            command: 'printf %s "<username>:<password>" | lanes link secrets set post/will --profile personal',
          },
        ],
        then: 'lanes link connect post --id ada --non-interactive --profile personal',
      }),
    );

    expect(out).toContain('lanes link secrets set post/will');
    expect(out).toContain('lanes link connect post --id ada --non-interactive');
    // What is missing is named, so a person knows what they are being asked for
    // before they go and find it.
    expect(out).toContain('App password');
  });

  test('a browser refusal names the one command, and asks for no value', () => {
    const { out } = captured(() =>
      renderOutcome({
        ...NOTHING,
        ok: false,
        reason: 'needs_browser',
        message: 'Notion authorises in a browser, which needs the person whose account it is.',
        needs: [],
        then: 'lanes link connect notion --profile personal',
      }),
    );

    expect(out).toContain('a browser is needed');
    expect(out).toContain('lanes link connect notion --profile personal');
    expect(out).not.toContain('secrets set');
  });
});

describe('a successful outcome', () => {
  test('says to restart rather than to start', () => {
    // "Next: lanes link start" reads as "you are done" to somebody who already
    // has one running, and the endpoint they have is still serving the config it
    // was started with.
    const { out } = captured(() =>
      renderOutcome({
        ok: true,
        key: 'post.ada',
        account: 'ada@example.test',
        changes: ['connections += post.ada (ada@example.test)'],
        granted: ['post.*'],
        discovered: 4,
        writable: 1,
        next: RESTART,
      }),
    );

    expect(out).toContain('connected');
    expect(out).toContain('Restart the endpoint');
    expect(out).toContain('1 of them write');
  });

  test('an unchanged reconnect says so and stops', () => {
    const { out } = captured(() =>
      renderOutcome({ ...NOTHING, ok: true, key: 'post.ada', next: ALREADY }),
    );

    expect(out).toContain('post.ada is already connected.');
    expect(out).not.toContain('Restart');
  });

  test('a family prints nothing extra, since each service already reported', () => {
    const { out } = captured(() =>
      renderOutcome({ ...NOTHING, ok: true, members: [{ ...NOTHING, ok: true, key: 'a.main' }] }),
    );

    expect(out).toBe('');
  });
});

describe('what to do after connecting', () => {
  test('a local target is restarted, a deployed one is replaced', () => {
    // Told to restart `lanes link start` after authorising an account against a
    // deployment, an operator restarts a server that was not serving it and
    // watches the deployed one go on refusing.
    expect(nextAfterConnect(false)).toContain('lanes link start');
    expect(nextAfterConnect(true)).toContain('lanes link deploy');
    expect(nextAfterConnect(true)).not.toContain('lanes link start');
  });
});
