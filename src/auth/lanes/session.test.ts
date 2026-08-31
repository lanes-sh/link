import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSession,
  isFresh,
  readSession,
  sessionPath,
  writeSession,
  type LanesSession,
} from './session.ts';

/**
 * The file holding this machine's Lanes session.
 *
 * Two properties, and both are about failing safely rather than about the happy
 * path. It holds a refresh token, so its mode is part of its correctness; and it
 * is read before every command that consumes a profile, so a damaged one has to
 * read as "signed out" rather than throw a JSON error out of an unrelated
 * command.
 */

const homes: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-session-'));
  homes.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(homes.map((one) => rm(one, { recursive: true, force: true })));
});

const SESSION: LanesSession = {
  subject: 'lanes:3QBmAxJLLrYSMTVUIeCN1SKFbdD3',
  email: 'someone@example.com',
  refreshToken: 'a-refresh-token',
  idToken: 'an-id-token',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  apiUrl: 'https://api.example.com',
};

describe('the session file', () => {
  test('round-trips what was written', async () => {
    const root = await home();
    await writeSession(SESSION, root);

    expect(await readSession(root)).toEqual(SESSION);
  });

  test('is written 0600, because it holds a refresh token', async () => {
    const root = await home();
    await writeSession(SESSION, root);

    const mode = (await stat(sessionPath(root))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('reads as signed out when it is not there', async () => {
    expect(await readSession(await home())).toBeNull();
  });

  test('reads as signed out when it is damaged, rather than throwing', async () => {
    // The property that matters most. This is read before commands that have
    // nothing to do with auth, and a JSON parse error surfacing out of
    // `lanes link memory list` would send somebody to entirely the wrong place.
    const root = await home();
    await mkdir(join(root, '.lanes'), { recursive: true });
    await writeFile(sessionPath(root), '{ not json');

    expect(await readSession(root)).toBeNull();
  });

  test('reads as signed out when a field is missing', async () => {
    // Shape-checked rather than cast. A file with a subject and no refresh
    // token would otherwise present as signed in and fail on the first refresh,
    // which is the same failure one step later and harder to read.
    const root = await home();
    await mkdir(join(root, '.lanes'), { recursive: true });
    await writeFile(sessionPath(root), JSON.stringify({ subject: 'lanes:x' }));

    expect(await readSession(root)).toBeNull();
  });

  test('signing out leaves a file that reads as signed out', async () => {
    const root = await home();
    await writeSession(SESSION, root);
    await clearSession(root);

    expect(await readSession(root)).toBeNull();
  });
});

describe('whether a token is still worth presenting', () => {
  test('a token an hour out is fresh', () => {
    expect(isFresh(SESSION)).toBe(true);
  });

  test('one that has passed is not', () => {
    const stale = { ...SESSION, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(isFresh(stale)).toBe(false);
  });

  test('one about to pass is not, because the request has to arrive too', () => {
    // A minute of slack. Refreshing slightly early costs a round trip;
    // refreshing slightly late costs a failed command, and the failure lands on
    // whatever the operator was actually doing.
    const soon = { ...SESSION, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    expect(isFresh(soon)).toBe(false);
  });

  test('an unparseable expiry is not fresh, which fails closed', () => {
    expect(isFresh({ ...SESSION, expiresAt: 'whenever' })).toBe(false);
  });
});
