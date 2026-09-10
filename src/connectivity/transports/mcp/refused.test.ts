import { describe, expect, test } from 'bun:test';
import { UnauthorizedError } from '@modelcontextprotocol/client';
import { distrustIfRefused } from './refused.ts';

/**
 * Noticing a refused credential on the transport that could not see one.
 *
 * The `http` connector reads `response.status`. Here the reply is consumed by a
 * client library that turns a 401 into an exception, so there was no status for
 * anything to check — and this is the larger half of the estate.
 */

describe('an upstream server that refused the credential', () => {
  test('is handed back for the same check a transported reply gets', async () => {
    const seen: number[] = [];

    await distrustIfRefused(async (response) => void seen.push(response.status), new UnauthorizedError('nope'));

    expect(seen).toEqual([401]);
  });

  /**
   * Everything else is left alone. The whole trade is that a false positive
   * spends a refresh on a guess, so this is matched on the library's own error
   * type rather than on the message text, which is where a guess would live.
   */
  test('an ordinary upstream failure is not mistaken for one', async () => {
    const seen: number[] = [];
    const verify = async (response: Response) => void seen.push(response.status);

    await distrustIfRefused(verify, new Error('the server returned 401 in some other sentence'));
    await distrustIfRefused(verify, new Error('upstream timed out'));
    await distrustIfRefused(verify, 'not an error at all');

    expect(seen).toEqual([]);
  });

  /** Discovery has no verifier, and must not throw for the want of one. */
  test('does nothing where there is no verifier to tell', async () => {
    await expect(distrustIfRefused(undefined, new UnauthorizedError('nope'))).resolves.toBeUndefined();
  });
});
