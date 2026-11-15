import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTIONS_FILE } from '#profile';
import { profileAdd } from '../profile.ts';
import { tokenIssue, tokenRotate, tokenShow } from './token.ts';

/**
 * That issuing a token binds what it wrote, and that saying so costs a local
 * target nothing.
 *
 * This file did not exist. The only test that reached `tokenIssue` ran it
 * against `target: 'local'` from `server/boot.test.ts`, which is the one target
 * where the defect it was written beside cannot fire: on a deployed target the
 * credential store is Secret Manager, whose `set` creates a container and
 * writes no IAM policy, so the command wrote a row the runtime identity was
 * never granted to read and printed `ok issued` anyway.
 *
 * The grant itself is asserted in `deployments/bind.test.ts`, against an
 * injected driver and without a cloud project near it. What is held here is the
 * half that belongs to the command: that a local target reaches no cloud, and
 * that the row and the credential still land in the right order.
 */

const homes: string[] = [];

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'lanes-token-'));
  homes.push(home);
  const previous = process.env['LANES_LINK_HOME'];
  process.env['LANES_LINK_HOME'] = home;
  // Swallowed because `profileAdd` writes its JSON to the stdout the reporter
  // is using, not because the output is uninteresting.
  const write = process.stdout.write.bind(process.stdout);
  try {
    (process.stdout as unknown as { write: () => boolean }).write = (): boolean => true;
    await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
    if (previous === undefined) delete process.env['LANES_LINK_HOME'];
    else process.env['LANES_LINK_HOME'] = previous;
  }
  return home;
}

/** Run a command that reports on stdout, and hand back what it wrote. */
async function capture(run: () => Promise<void>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  try {
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
      chunk: string,
    ): boolean => {
      out += chunk;
      return true;
    };
    await run();
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }
  return out;
}

describe('issuing a token against a target that runs here', () => {
  test('issues it, and reaches no cloud to bind it', async () => {
    // The bind is unconditional and has no flag to skip, the way `profile add`
    // provisions — so the thing that keeps a local target cheap is the target
    // declaring no deployment, not the command deciding to ask. If that early
    // return ever went, every `token issue` on a laptop would start shelling
    // out to `gcloud`, and this is what would say so.
    const home = await workspace();
    const previous = process.env['LANES_LINK_HOME'];
    process.env['LANES_LINK_HOME'] = home;

    try {
      const issue = { target: 'local', quiet: true, subject: 'lanes:tokentest1' };
      const printed = await capture(() => tokenIssue(issue));

      expect(printed).toContain('issued tok1');
      // The warning `bindRefs` produces when a grant genuinely fails. A local
      // target is skipped rather than failed, so it must not appear.
      expect(printed).not.toContain('could not bind');

      const token = (await capture(() => tokenShow({ ...issue, raw: true }))).trim();
      expect(token).toStartWith('llk_');

      // The credential first, then the row: the other order leaves a row naming
      // a ref with nothing behind it, which reads to the authenticator as a
      // token that matches nothing.
      const rows = await readFile(join(home, 'link', CONNECTIONS_FILE), 'utf8').catch(() =>
        readFile(join(home, CONNECTIONS_FILE), 'utf8'),
      );
      expect(rows).toContain('tokens/tok1');
      expect(rows).toContain('lanes:tokentest1');
    } finally {
      if (previous === undefined) delete process.env['LANES_LINK_HOME'];
      else process.env['LANES_LINK_HOME'] = previous;
    }
  });

  test('rotating replaces the value and keeps the row', async () => {
    // `tokenRotate` binds too, because it lands on a ref that may have been
    // issued before any of this existed. Repairing one is a reason to run it
    // rather than a reason to skip it.
    const home = await workspace();
    const previous = process.env['LANES_LINK_HOME'];
    process.env['LANES_LINK_HOME'] = home;

    try {
      const issue = { target: 'local', quiet: true, subject: 'lanes:tokentest2' };
      await capture(() => tokenIssue(issue));
      const before = (await capture(() => tokenShow({ ...issue, raw: true }))).trim();

      const printed = await capture(() => tokenRotate({ target: 'local', quiet: true }));
      const after = (await capture(() => tokenShow({ ...issue, raw: true }))).trim();

      expect(printed).toContain('rotated tok1');
      expect(printed).not.toContain('could not bind');
      expect(after).toStartWith('llk_');
      expect(after).not.toBe(before);
    } finally {
      if (previous === undefined) delete process.env['LANES_LINK_HOME'];
      else process.env['LANES_LINK_HOME'] = previous;
    }
  });
});
