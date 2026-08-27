import { describe, expect, test } from 'bun:test';
import type { Prompter } from '../../../prompt.ts';
import { collect } from './ask.ts';
import { AUTH_METHODS, CONNECTOR_KINDS, type CustomFlags } from './spec.ts';

/**
 * That every value has a flag *and* a question, and that a run with nobody to
 * ask says everything it needs in one go.
 *
 * The second half is the one worth testing. A non-interactive caller is usually
 * a script or an agent, and a refusal naming one missing flag at a time costs it
 * a whole run per flag — which is the difference between one round trip and six.
 */

/** Records what was asked, and answers from a queue. */
function answering(...answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let next = 0;

  return {
    asked,
    interactive: true,
    ask: async (question) => {
      asked.push(question.trim());
      return answers[next++] ?? '';
    },
    askSecret: async () => {
      throw new Error('collect must never ask for a secret — that is the manifest\'s job');
    },
    confirm: async () => true,
  };
}

const silent: Prompter = {
  interactive: false,
  ask: async () => {
    throw new Error('asked on a non-interactive run');
  },
  askSecret: async () => {
    throw new Error('asked on a non-interactive run');
  },
  confirm: async () => {
    throw new Error('asked on a non-interactive run');
  },
};

const command = (missing: readonly string[]) =>
  ['lanes link connect custom thing', ...missing.map((flag) => `--${flag} <value>`)].join(' ');

const gather = (flags: CustomFlags, prompter: Prompter) =>
  collect('thing', flags, prompter, command);

describe('what the flags did not say is asked for', () => {
  test('the two lists first, then the fields they decide', async () => {
    // Order matters: which fields exist at all depends on the two answers, so
    // they cannot be asked in the other order or asked together.
    const prompter = answering('2', '2', 'https://api.example.com/v1', 'https://api.example.com/spec.json', '');
    const result = await gather({}, prompter);

    expect('missing' in result).toBe(false);
    // Counted from the lists rather than written down: a member landing in
    // either union is not a reason for this test to fail.
    expect(prompter.asked[0]).toBe(`Choose 1-${CONNECTOR_KINDS.length}:`);
    expect(prompter.asked[1]).toBe(`Choose 1-${AUTH_METHODS.length}:`);
    expect(prompter.asked.slice(2, 4)).toEqual(['Base URL:', 'OpenAPI document:']);
  });

  test('a member can be typed by name instead of counted', async () => {
    const result = await gather(
      { connector: 'mcp' },
      answering('bearer', 'https://mcp.example.com/mcp', ''),
    );

    expect(result).toMatchObject({ connector: 'mcp', auth: 'bearer' });
  });

  test('a name that is not a member says what the members are', async () => {
    await expect(gather({ connector: 'mcp' }, answering('apikey'))).rejects.toThrow(
      /not one of: none, bearer, api-key/,
    );
  });

  test('an optional field is never asked for', async () => {
    // A question nobody needs to answer is worse than a flag nobody types.
    const prompter = answering('https://mcp.example.com/mcp', '');
    await gather({ connector: 'mcp', auth: 'none' }, prompter);

    expect(prompter.asked).toEqual(['MCP endpoint:', 'Display name [Thing]:']);
  });

  test('the display name defaults to the id, read as words', async () => {
    const result = await gather(
      { connector: 'fs', auth: 'none', root: '~/Notes' },
      answering(''),
    );

    expect(result).toMatchObject({ name: 'Thing' });
  });

  test('and an answer overrides it', async () => {
    const result = await gather(
      { connector: 'fs', auth: 'none', root: '~/Notes' },
      answering('Acme Billing'),
    );

    expect(result).toMatchObject({ name: 'Acme Billing' });
  });
});

describe('a run with nobody to ask', () => {
  test('names every missing value at once, not the first one', async () => {
    const result = await gather({ connector: 'http', auth: 'header' }, silent);

    expect(result).toMatchObject({ missing: ['base-url', 'openapi', 'auth-header'] });
  });

  test('and hands back a command that carries the selection', async () => {
    // Asserted because a suggested command missing --profile or --target is
    // refused the moment it is pasted, which reads as the tool being broken.
    const result = await gather({ connector: 'mcp', auth: 'none' }, silent);

    expect('missing' in result && result.command).toMatch(/--endpoint <value>/);
  });

  test('a missing list stops at the two lists, because the rest is not knowable yet', async () => {
    // Which fields exist depends on both, so listing "the rest" would be a
    // guess that is wrong for four of the five connectivity types.
    const result = await gather({}, silent);

    expect(result).toMatchObject({ missing: ['connector', 'auth'] });
  });

  test('the display name is defaulted rather than blocked on', async () => {
    // Cosmetic, and never worth costing a scripted run a whole round trip.
    const result = await gather(
      { connector: 'fs', auth: 'none', root: '~/Notes' },
      silent,
    );

    expect(result).toMatchObject({ name: 'Thing' });
  });
});

describe('a pairing that cannot work', () => {
  test('is refused before a single field is asked for', async () => {
    // Six questions about a mailbox, and then a refusal about its credential
    // type, is worse than refusing straight away.
    const prompter = answering('imap.example.com');

    await expect(gather({ connector: 'imap', auth: 'bearer' }, prompter)).rejects.toThrow(
      /Use --auth basic/,
    );
    expect(prompter.asked).toEqual([]);
  });
});

describe('a flag belonging to another kind', () => {
  test('is ignored rather than smuggled into the manifest', async () => {
    // `derive.ts` reads only the fields the chosen kind declares, so an imap
    // flag on an mcp connector cannot reach the file. Pinned so a future change
    // to the lookup does not quietly start honouring it.
    const result = await gather(
      { connector: 'mcp', auth: 'none', endpoint: 'https://mcp.example.com/mcp', host: 'imap.example.com' },
      answering(''),
    );

    expect('missing' in result).toBe(false);
    expect('values' in result && result.values).not.toHaveProperty('host');
  });
});
