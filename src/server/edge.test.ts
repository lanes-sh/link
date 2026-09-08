import { describe, expect, test } from 'bun:test';
import { authenticateRequest, tooManyAttempts } from './edge.ts';
import type { Authenticator } from '#auth';
import type { Logger } from '#connectivity';

/**
 * What this endpoint does about a caller it cannot authenticate — including the
 * case where the reason has nothing to do with the caller.
 *
 * Both of these are about a client being told something it can act on. A bearer
 * token is refreshed because a `WWW-Authenticate` header said to, and a request
 * is retried because a status said it was worth retrying. Getting either wrong
 * does not fail loudly: it produces a connector that works, then does not, then
 * does again, which is indistinguishable from an unreliable endpoint.
 */

function recordingLogger(): { log: Logger; errors: string[] } {
  const errors: string[] = [];
  const noop = () => {};

  return {
    errors,
    log: {
      debug: noop,
      info: noop,
      warn: noop,
      error: (message: string) => errors.push(message),
    } as unknown as Logger,
  };
}

const request = (): Request =>
  new Request('https://endpoint.example/mcp', { headers: { authorization: 'Bearer llk_whatever' } });

describe('authenticating a request', () => {
  test('a credential store that throws answers 503, not a bare 500', async () => {
    // There is no `catch` in the router, so before this an unreachable bucket
    // escaped the fetch handler: no log line, no audit, and a 500 that every
    // client renders as "the connector is unavailable".
    const authenticator: Authenticator = {
      authenticate: async () => {
        throw new Error('bucket said 503');
      },
    };
    const { log, errors } = recordingLogger();

    const outcome = await authenticateRequest(authenticator, request(), log);

    expect(outcome).toBeInstanceOf(Response);
    const response = outcome as Response;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');

    // And it is not a 401: the credential may be perfectly good, and telling a
    // client to refresh a token that is not the problem is how a transient
    // bucket error turns into someone being asked to authorise again.
    expect(response.status).not.toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unavailable' });

    // The failure that used to be invisible is now in the log.
    expect(errors).toContain('could not authenticate');
  });

  test('an outcome is passed through untouched', async () => {
    const authenticator: Authenticator = {
      authenticate: async () => ({ ok: false, reason: 'invalid' }) as never,
    };

    const outcome = await authenticateRequest(authenticator, request(), recordingLogger().log);

    expect(outcome).not.toBeInstanceOf(Response);
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('the ceiling on failed authentication', () => {
  test('still tells a client how to authenticate', () => {
    // The 429 stands in for a 401, and the header is the whole reason a client
    // refreshes rather than giving up. Without it, a connector with several
    // sessions retrying a lapsed token spends the budget in seconds, gets an
    // opaque rate limit, and recovers a minute later on its own — which reads as
    // an endpoint that is intermittently down.
    const refused = tooManyAttempts(30_000, 'https://endpoint.example/.well-known/oauth-protected-resource');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('www-authenticate')).toContain('Bearer');
    expect(refused.headers.get('www-authenticate')).toContain('invalid_token');
    expect(refused.headers.get('retry-after')).toBe('30');
  });

  test('says nothing about credentials where there is no credential to challenge for', () => {
    // The pre-auth ceilings meter `.well-known` and `/register`, which no token
    // opens. A challenge there would be an invitation to refresh nothing.
    expect(tooManyAttempts(1_000).headers.get('www-authenticate')).toBeNull();
  });
});
