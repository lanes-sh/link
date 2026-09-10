import { describe, expect, test } from 'bun:test';
import { pairingSessions, reaches, SESSION_PREFIX, type SessionStore } from './session.ts';

/**
 * The store behind the dashboard's credential.
 *
 * What it has to get right is narrow, and each half is a way the surface it
 * guards could be opened by somebody it does not name: a session that outlives
 * its window, a nonce that can be spent twice, a token written where the thing
 * it opens is written.
 */

function memory(): SessionStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const at = (namespace: string, key: string) => `${namespace}/${key}`;
  return {
    rows,
    get: async (namespace, key) => rows.get(at(namespace, key)) ?? null,
    set: async (namespace, key, value) => void rows.set(at(namespace, key), value),
    delete: async (namespace, key) => void rows.delete(at(namespace, key)),
  };
}

const HER = { subject: 'lanes:HER', profiles: ['personal'] };

describe('a session', () => {
  test('resolves to the subject and profiles it was opened for', async () => {
    const sessions = pairingSessions(memory());

    const { token } = await sessions.open(HER);

    expect(await sessions.resolve(token)).toEqual(HER);
  });

  test('stops resolving once its window has passed', async () => {
    let clock = 1_000;
    const sessions = pairingSessions(memory(), { now: () => clock, ttlMs: 60_000 });

    const { token } = await sessions.open(HER);
    clock += 59_000;
    expect(await sessions.resolve(token)).not.toBeNull();

    clock += 2_000;

    expect(await sessions.resolve(token)).toBeNull();
  });

  test('a token nobody minted resolves to nothing', async () => {
    const sessions = pairingSessions(memory());

    expect(await sessions.resolve(`${SESSION_PREFIX}invented`)).toBeNull();
  });

  test('the workspace pairing token is not a session, whatever else it opens', async () => {
    // The two credentials are the whole point of the split. A pairing token
    // presented here must miss rather than be read as a session naming nobody,
    // which is what the prefix check is for.
    const sessions = pairingSessions(memory());

    expect(await sessions.resolve('llp_a-pairing-token')).toBeNull();
  });

  test('closing one ends it', async () => {
    const sessions = pairingSessions(memory());
    const { token } = await sessions.open(HER);

    await sessions.close(token);

    expect(await sessions.resolve(token)).toBeNull();
  });

  test('the token itself is never written to the store', async () => {
    // The KV behind this is the workspace's own state store, which on a
    // deployed workspace is a bucket the revision reads. A session kept
    // verbatim there would be a live credential sitting beside the data it
    // opens.
    const kv = memory();
    const sessions = pairingSessions(kv);

    const { token } = await sessions.open(HER);

    expect([...kv.rows.keys()].some((key) => key.includes(token))).toBe(false);
    expect([...kv.rows.values()].some((value) => value.includes(token))).toBe(false);
  });

  test('two sessions do not collide', async () => {
    const sessions = pairingSessions(memory());

    const first = await sessions.open(HER);
    const second = await sessions.open({ subject: 'lanes:HIM', profiles: ['work'] });

    expect(first.token).not.toBe(second.token);
    expect((await sessions.resolve(first.token))?.subject).toBe('lanes:HER');
    expect((await sessions.resolve(second.token))?.subject).toBe('lanes:HIM');
  });
});

describe('a challenge', () => {
  test('is spent exactly once', () => {
    // What stops one assertion opening two sessions.
    const sessions = pairingSessions(memory());

    return sessions.challenge().then(async (nonce) => {
      expect(await sessions.spend(nonce)).toBe(true);
      expect(await sessions.spend(nonce)).toBe(false);
    });
  });

  test('one nobody minted cannot be spent', async () => {
    const sessions = pairingSessions(memory());

    expect(await sessions.spend('invented')).toBe(false);
  });

  test('expires, and is consumed even so', async () => {
    // Spent whether or not it was still valid. Leaving an expired row in place
    // would let a slow replay keep trying against something that never goes
    // away.
    let clock = 1_000;
    const kv = memory();
    const sessions = pairingSessions(kv, { now: () => clock });
    const nonce = await sessions.challenge();

    clock += 10 * 60 * 1000;

    expect(await sessions.spend(nonce)).toBe(false);
    expect(kv.rows.size).toBe(0);
  });

  test('two challenges are different', async () => {
    const sessions = pairingSessions(memory());

    expect(await sessions.challenge()).not.toBe(await sessions.challenge());
  });
});

describe('what a session reaches', () => {
  test('the profiles it names, and nothing else', () => {
    expect(reaches(HER, 'personal')).toBe(true);
    expect(reaches(HER, 'work')).toBe(false);
  });

  test('a session on no profile reaches nothing', () => {
    // Signing in and reaching nothing is a normal outcome rather than an error,
    // and it must not read as "unrestricted" anywhere.
    expect(reaches({ subject: 'lanes:HER', profiles: [] }, 'personal')).toBe(false);
  });
});
