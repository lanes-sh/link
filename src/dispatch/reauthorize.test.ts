import { describe, expect, test } from 'bun:test';
import { reauthResult, responseVerifier } from './reauthorize.ts';

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

describe('telling a dead grant from a stale token', () => {
  const verifier = (exhausted: string[]) =>
    responseVerifier({
      connectionKey: 'gmail.con1',
      oauth: true,
      distrust: () => {},
      exhausted: (key) => exhausted.push(key),
    })!;

  /**
   * The first refusal says nothing. A token can be stale for reasons that fix
   * themselves, and usually is — reporting it would turn every recovered call
   * into an instruction to go and reconnect something that is working.
   */
  test('a first refusal is not reported, because a retry may still fix it', async () => {
    const exhausted: string[] = [];

    expect(await verifier(exhausted)(refused)).toEqual({ retry: true });
    expect(exhausted).toEqual([]);
  });

  /**
   * The second one says everything. The token being presented is the one the
   * refresh just produced, so what is being refused is the grant.
   */
  test('a refusal that outlived the refresh is reported', async () => {
    const exhausted: string[] = [];
    const verify = verifier(exhausted);

    await verify(refused);
    await verify(refused);

    expect(exhausted).toEqual(['gmail.con1']);
  });

  test('and it is not asked to retry a second time', async () => {
    const verify = verifier([]);

    await verify(refused);
    expect(await verify(refused)).toBeUndefined();
  });

  test('a call that recovered reports nothing', async () => {
    const exhausted: string[] = [];
    const verify = verifier(exhausted);

    await verify(refused);
    await verify(fine);

    expect(exhausted).toEqual([]);
  });
});

describe('what a dead grant is said to be', () => {
  const vendor = {
    content: [{ type: 'text' as const, text: '401 Unauthorized\n{"error":"invalid_grant"}' }],
    isError: true,
  };

  test('names the connection, and says retrying will not help', async () => {
    const said = reauthResult('gmail.con1', vendor) as unknown as { content: { text: string }[] };

    expect(said.content[0]?.text).toContain('gmail.con1');
    expect(said.content[0]?.text).toContain('connected again');
    expect(said.content[0]?.text).toContain('Retrying will not help');
  });

  /** The vendor's own words stay: they are the evidence for whoever debugs it. */
  test("keeps what the vendor said, after what it means", async () => {
    const said = reauthResult('gmail.con1', vendor) as unknown as {
      content: { text: string }[];
      isError: boolean;
    };

    expect(said.content).toHaveLength(2);
    expect(said.content[1]?.text).toContain('invalid_grant');
    expect(said.isError).toBe(true);
  });
});
