import { describe, expect, test } from 'bun:test';
import { contextBox, reachOf } from './context-box.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * The box says what a call may be routed to, and nothing more.
 *
 * The rule worth a test of its own is the negative one: it is derived from the
 * merged set, so it cannot name a profile or a connection this caller was not
 * already going to be told about. A box built from the workspace's own
 * connection list would be a discovery leak wearing a summary's clothes.
 */

function capability(reachable: Record<string, string[]>): MergedCapability {
  return {
    reachable: new Map(Object.entries(reachable)),
    capability: undefined,
    discovered: { name: 'x', title: 'x', description: 'x', inputSchema: { type: 'object' } },
  } as unknown as MergedCapability;
}

describe('what this caller can reach', () => {
  test('is the union across capabilities, per profile', () => {
    const merged = new Map([
      ['mail.list', capability({ personal: ['mail.acct1'], work: ['mail.acct2'] })],
      ['mail.send', capability({ personal: ['mail.acct1', 'mail.acct3'] })],
      ['notes.list', capability({ work: ['notes.acct1'] })],
    ]);

    expect(reachOf(merged)).toEqual([
      { profile: 'personal', connections: ['mail.acct1', 'mail.acct3'] },
      { profile: 'work', connections: ['mail.acct2', 'notes.acct1'] },
    ]);
  });

  /**
   * A connection no capability is reachable through is not a routing option.
   * Listing it would offer a `connection` value that every call using it
   * refuses — which is worse than not mentioning it, because the model would
   * spend a call finding out.
   */
  test('a connection granted nothing does not appear', () => {
    const merged = new Map([['mail.list', capability({ personal: ['mail.acct1'] })]]);
    expect(reachOf(merged)[0]?.connections).toEqual(['mail.acct1']);
  });

  test('nothing reachable renders no box at all', () => {
    expect(contextBox(reachOf(new Map()), new Map())).toEqual([]);
  });
});

describe('the rendered box', () => {
  const reach = reachOf(
    new Map([
      ['mail.list', capability({ personal: ['mail.acct1'], work: ['mail.acct2'] })],
    ]),
  );

  test('counts what it lists', () => {
    const box = contextBox(reach, new Map()).join('\n');
    expect(box).toContain('2 profiles, 2 connections');
    expect(box).toContain('Every call names one of each');
  });

  test('names the account where the endpoint knows it', () => {
    const accounts = new Map([
      ['personal', new Map([['mail.acct1', 'ada.lovelace@example.com']])],
      ['work', new Map<string, string>()],
    ]);
    const box = contextBox(reach, accounts).join('\n');

    expect(box).toContain('mail.acct1 (ada.lovelace@example.com)');
    // And falls back to the bare ref, which is still the value a call takes.
    expect(box).toContain('mail.acct2');
    expect(box).not.toContain('mail.acct2 (');
  });
});
