import { describe, expect, test } from 'bun:test';
import { defaultConnectionLabel } from './connections.ts';

/**
 * What a connection is called when nobody has named it.
 *
 * One rule, read by four surfaces: the label `connect` offers, the label it
 * declines to write because it offered it, the name `connection list` prints,
 * and the name the dashboard shows. They agreed on the account before this
 * existed, which is why an unlabelled row read as its address in one place and
 * as `con8` in another.
 */
describe('defaultConnectionLabel', () => {
  test('is the provider and the account, so two mailboxes are two names', () => {
    expect(defaultConnectionLabel('Gmail', 'ada@example.com')).toBe('Gmail (ada)');
    expect(defaultConnectionLabel('Gmail', 'rin@example.com')).toBe('Gmail (rin)');
  });

  test('takes the local part, because the domain repeats on every address at one', () => {
    expect(defaultConnectionLabel('iCloud Mail', 'ada@example.test')).toBe('iCloud Mail (ada)');
  });

  test('keeps an account that is not an address whole', () => {
    // `Lanes HQ` cut at the space is `Lanes`, which is a different workspace's
    // name as often as not. There is no first part to guess at here.
    expect(defaultConnectionLabel('Notion', 'Acme HQ')).toBe('Notion (Acme HQ)');
    expect(defaultConnectionLabel('GitHub', 'acme-sh')).toBe('GitHub (acme-sh)');
  });

  test('is the provider alone where there is no account behind it', () => {
    // The owner layer. Its rows carry the proper noun in `account` already, so
    // composing the two would read `Memory (Memory)`.
    expect(defaultConnectionLabel('Memory', 'Memory')).toBe('Memory');
    expect(defaultConnectionLabel('Vault', null)).toBe('Vault');
    expect(defaultConnectionLabel('Setup', undefined)).toBe('Setup');
  });

  test('an empty account is no account', () => {
    expect(defaultConnectionLabel('Gmail', '')).toBe('Gmail');
    // And an address with nothing before the `@` falls back to the whole of it
    // rather than to `Gmail ()`.
    expect(defaultConnectionLabel('Gmail', '@example.com')).toBe('Gmail (@example.com)');
  });
});
