import { describe, expect, test } from 'bun:test';
import { clientLabelFrom } from './client-info.ts';

/**
 * Which agent called, read off the request.
 *
 * The shape is the SDK's and not ours, so the fixtures here are the real one:
 * `extra.mcpReq.envelope['io.modelcontextprotocol/clientInfo']`. A test written
 * against `extra._meta` would have passed against the first attempt at this,
 * which read nothing on a live endpoint.
 */

const KEY = 'io.modelcontextprotocol/clientInfo';

function request(envelope: unknown): unknown {
  return { sessionId: 's', mcpReq: { id: 1, method: 'tools/call', envelope } };
}

describe('clientLabelFrom', () => {
  test('reads the name a client repeated on this request', () => {
    expect(clientLabelFrom(request({ [KEY]: { name: 'Claude Code', version: '5.0' } }))).toBe(
      'Claude Code',
    );
  });

  test('a client that announced itself only at initialize stays anonymous', () => {
    // The SDK does not backfill the envelope from the handshake, and inferring
    // one would mean keeping a session table to hold a field nothing may trust.
    expect(clientLabelFrom(request(undefined))).toBeUndefined();
  });

  test.each([
    ['nothing at all', undefined],
    ['a null', null],
    ['a string', 'Claude Code'],
    ['no request', { sessionId: 's' }],
    ['an envelope that is not an object', request('Claude Code')],
    ['an entry that is not an object', request({ [KEY]: 'Claude Code' })],
    ['a name that is not a string', request({ [KEY]: { name: 7 } })],
    ['an empty name', request({ [KEY]: { name: '' } })],
  ])('undefined rather than a throw for %s', (_what, input) => {
    // Untrusted input on a path whose failure would otherwise be an exception
    // inside a tool call that was going to succeed. The worst honest outcome is
    // the empty field that already existed.
    expect(clientLabelFrom(input)).toBeUndefined();
  });
});
