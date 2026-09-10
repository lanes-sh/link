import { describe, expect, test } from 'bun:test';
import { responseVerifier } from './reauthorize.ts';

/**
 * Who gets told that a call came back refused.
 *
 * Two verifiers can want the same response: the one a signing vendor demands,
 * and the one that exists to notice a refused token. They compose rather than
 * exclude, because a strategy that verifies signatures has nothing to say about
 * credentials and the reverse is equally true.
 */

const refused = new Response('', { status: 401 });
const fine = new Response('', { status: 200 });

describe('an oauth connection', () => {
  test('stops trusting its token when the vendor refuses it, and asks for one retry', async () => {
    const distrusted: string[] = [];
    const verify = responseVerifier({
      connectionKey: 'gmail.con1',
      oauth: true,
      distrust: (key) => distrusted.push(key),
    })!;

    expect(await verify(refused)).toEqual({ retry: true });
    expect(distrusted).toEqual(['gmail.con1']);
  });

  test('leaves a response that was not refused alone', async () => {
    const distrusted: string[] = [];
    const verify = responseVerifier({
      connectionKey: 'gmail.con1',
      oauth: true,
      distrust: (key) => distrusted.push(key),
    })!;

    expect(await verify(fine)).toBeUndefined();
    expect(distrusted).toEqual([]);
  });

  test('asks for a retry once, so a second refusal is the answer', async () => {
    // The verifier is built per invocation, so the guard lives here rather than
    // in the transport, where it would have to be threaded through every kind.
    const verify = responseVerifier({
      connectionKey: 'gmail.con1',
      oauth: true,
      distrust: () => {},
    })!;

    expect(await verify(refused)).toEqual({ retry: true });
    expect(await verify(refused)).toBeUndefined();
  });
});

describe('a connection that is not oauth', () => {
  test('gets no verifier at all, so nothing is retried', () => {
    // Basic auth and api keys do not go stale mid-flight, and a retry would be
    // one more refusal for a credential that needs a person to change it.
    expect(
      responseVerifier({ connectionKey: 'icloud_mail.con3', oauth: false, distrust: () => {} }),
    ).toBeUndefined();
  });
});

describe('a strategy that verifies its own replies', () => {
  test('still runs, and its answer wins where it has one', async () => {
    const seen: number[] = [];
    const verify = responseVerifier({
      connectionKey: 'bunq.con6',
      oauth: false,
      distrust: () => {},
      strategy: async (response) => void seen.push(response.status),
    })!;

    expect(await verify(fine)).toBeUndefined();
    expect(seen).toEqual([200]);
  });

  test('composes with the credential check rather than replacing it', async () => {
    const seen: number[] = [];
    const distrusted: string[] = [];
    const verify = responseVerifier({
      connectionKey: 'gmail.con1',
      oauth: true,
      distrust: (key) => distrusted.push(key),
      strategy: async (response) => void seen.push(response.status),
    })!;

    expect(await verify(refused)).toEqual({ retry: true });
    expect(seen).toEqual([401]);
    expect(distrusted).toEqual(['gmail.con1']);
  });
});
