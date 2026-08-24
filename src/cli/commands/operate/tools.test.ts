import { afterAll, describe, expect, test } from 'bun:test';
import { allocatePort, startHarness, TEST_TOKEN } from '../../../server/harness.ts';
import { askEndpoint, groupByProvider, parse, UNATTRIBUTED } from './tools.ts';

/**
 * What `lanes link tools` reports, and the two ways it used to be wrong.
 *
 * The command exists to answer "is my client stale or is my endpoint wrong",
 * which means every one of its own failure modes reads as an answer. A frame it
 * cannot parse becomes "0 tools"; a refusal becomes "unreachable"; a name it
 * cannot attribute becomes a confident heading. So the parts that can be wrong
 * quietly are the parts that are tested here.
 */

const harness = startHarness({
  profile: 'personal',
  port: allocatePort(),
  policy: `  allow:
    - "example.*"`,
});

afterAll(async () => {
  await harness.stop();
});

describe('reading the response frame', () => {
  const payload = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'example_echo' }] } };
  const body = JSON.stringify(payload);

  test('a plain JSON body', () => {
    expect(parse(body)).toEqual({ tools: [{ name: 'example_echo' }] });
  });

  test('an SSE frame', () => {
    expect(parse(`event: message\ndata: ${body}\n\n`)).toEqual({
      tools: [{ name: 'example_echo' }],
    });
  });

  test('an SSE frame with no space after the colon', () => {
    // Legal SSE, and the previous expression searched for `'data: '` while
    // gating on `'data:'` — so this parsed as `{}` and the command reported a
    // healthy endpoint as advertising nothing.
    expect(parse(`event: message\ndata:${body}\n\n`)).toEqual({
      tools: [{ name: 'example_echo' }],
    });
  });

  test('an SSE frame behind keep-alive comments', () => {
    // The legacy transport arms a keep-alive on every POST and this repository
    // passes no interval, so a handler that runs past the default emits comment
    // lines first. Inspecting the first characters of the body saw `: keepalive`,
    // fell through to `JSON.parse`, threw, and reported the endpoint down.
    expect(parse(`: keepalive\n\n: keepalive\n\nevent: message\ndata: ${body}\n\n`)).toEqual({
      tools: [{ name: 'example_echo' }],
    });
  });

  test('a JSON-RPC error becomes an error, not an empty result', () => {
    expect(() => parse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } }))).toThrow(
      'nope',
    );
  });
});

describe('grouping names by provider', () => {
  const ids = ['example.echo', 'icloud_mail.send_message', 'setup.overview'];

  test('a provider whose id contains an underscore keeps its own group', () => {
    // The whole reason this does not split on the first underscore:
    // `icloud_mail_send_message` would file under `icloud`, which is not a
    // provider any of these profiles has.
    const grouped = groupByProvider(['icloud_mail_send_message'], ids);

    expect([...grouped.keys()]).toEqual(['icloud_mail']);
  });

  test('several providers group separately, in name order', () => {
    const grouped = groupByProvider(['setup_overview', 'example_echo'], ids);

    expect([...grouped.keys()]).toEqual(['example', 'setup']);
  });

  test('a name matching nothing known is marked unattributed, not guessed', () => {
    // Reachable in normal use: the registry is the invoking profile's, and the
    // endpoint may serve several — or, under `--target cloud`, run an image
    // this checkout does not have. Filing `drive_files_list` under a confident
    // `drive` heading would be a guess wearing a count.
    const grouped = groupByProvider(['drive_files_list'], ids);

    expect([...grouped.keys()]).toEqual([UNATTRIBUTED]);
  });
});

describe('asking a real endpoint', () => {
  test('reports the advertised names, the payload size, and listChanged', async () => {
    const surface = await askEndpoint(harness.server.url, TEST_TOKEN);

    expect(surface.reachable).toBe(true);
    expect(surface.names).toContain('example_echo');
    expect(surface.bytes).toBeGreaterThan(0);
    // The subject of ADR-032: a client is told the list is not announced, so it
    // re-reads rather than trusting a notification that never arrives.
    expect(surface.listChanged).toBe(false);
  });

  test('a refused token is reported as a refusal, not as unreachable', async () => {
    // These are different problems with different fixes. Folding them together
    // sends someone to check whether the endpoint is up when it answered them
    // and declined — which is what a rotated token, or another workspace on the
    // same port, actually looks like.
    const surface = await askEndpoint(harness.server.url, 'llk_not_the_right_token');

    expect(surface.reachable).toBe(false);
    expect(surface.refused).toBe(true);
    expect(surface.reason).toContain('401');
  });

  test('an address with nothing behind it is reported as unreachable', async () => {
    const surface = await askEndpoint(`http://127.0.0.1:${allocatePort()}/mcp`, TEST_TOKEN);

    expect(surface.reachable).toBe(false);
    expect(surface.refused).toBeUndefined();
    expect(surface.names).toEqual([]);
  });
});
