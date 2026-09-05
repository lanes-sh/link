import { describe, expect, test } from 'bun:test';
import type { ConnectionConfig } from './schema.ts';
import {
  connectionForAccount,
  defaultConnectionLabel,
  duplicateAccountRows,
  sameAccount,
} from './connections.ts';

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

  /**
   * A qualified account keeps the half that tells it from its twin.
   *
   * `ada@example.com (Personal)` is what an identity block writes when one name
   * spans two tenants — Notion's email is the same email in every workspace the
   * person belongs to. Shortening on the `@` alone cut the bracket off, so both
   * workspaces read `Notion (ada)` and the field that exists to tell them apart
   * was the one nobody saw.
   */
  test('keeps the qualifier that makes two tenants two names', () => {
    expect(defaultConnectionLabel('Notion', 'ada@example.com (Personal)')).toBe(
      'Notion (ada (Personal))',
    );
    expect(defaultConnectionLabel('Notion', 'ada@example.com (Personal)')).not.toBe(
      defaultConnectionLabel('Notion', 'ada@example.com (Acme)'),
    );
  });

  test('and leaves a handle that was already qualified exactly as it was', () => {
    // Slack's shape, unchanged: its `user` is a handle, so there is no `@` to
    // shorten on and the whole string was already kept.
    expect(defaultConnectionLabel('Slack', 'ada (Acme)')).toBe('Slack (ada (Acme))');
  });

  test('an empty account is no account', () => {
    expect(defaultConnectionLabel('Gmail', '')).toBe('Gmail');
    // And an address with nothing before the `@` falls back to the whole of it
    // rather than to `Gmail ()`.
    expect(defaultConnectionLabel('Gmail', '@example.com')).toBe('Gmail (@example.com)');
  });
});

/**
 * Which row an account already has, asked in one place by two callers.
 *
 * `settleIdentity` picks the id a `connect` writes to and `declareConnection`
 * finds the row to write, and while they answered separately they could
 * disagree: the first matched an account across a whole vendor and returned a
 * sibling's id, the second looked up `<provider>.<id>`, found nothing under it,
 * and appended a second row for an account already declared.
 */
describe('connectionForAccount', () => {
  const declared: ConnectionConfig[] = [
    { id: 'con3', provider: 'acme_calendar', account: 'ada@example.com' },
    { id: 'con5', provider: 'acme_mail', account: 'ada@example.com' },
    { id: 'con6', provider: 'acme_mail', account: 'rin@example.com' },
  ];

  test('is this provider row, not another provider sharing the account', () => {
    // Both rows carry the account. Only one of them is a row this provider has.
    expect(connectionForAccount(declared, 'acme_mail', 'ada@example.com')?.id).toBe('con5');
    expect(connectionForAccount(declared, 'acme_calendar', 'ada@example.com')?.id).toBe('con3');
  });

  test('tells two accounts of one provider apart', () => {
    expect(connectionForAccount(declared, 'acme_mail', 'rin@example.com')?.id).toBe('con6');
  });

  test('is undefined where this provider holds no row for the account', () => {
    // The family case, and the reason the caller falls through to a sibling id
    // rather than treating this as "add a new account".
    expect(connectionForAccount(declared, 'acme_contacts', 'ada@example.com')).toBeUndefined();
    expect(connectionForAccount(declared, 'acme_mail', 'nobody@example.com')).toBeUndefined();
  });

  test('ignores case and surrounding space, because nothing normalises on the way in', () => {
    const spaced: ConnectionConfig[] = [
      { id: 'con5', provider: 'acme_mail', account: '  Ada@Example.com ' },
    ];

    expect(connectionForAccount(spaced, 'acme_mail', 'ada@example.com')?.id).toBe('con5');
    expect(sameAccount(' ADA@example.com', 'ada@example.com ')).toBe(true);
    expect(sameAccount('ada@example.com', 'rin@example.com')).toBe(false);
  });
});

/**
 * The pairs a workspace already holds, for `doctor` to name.
 *
 * Not an error: both rows resolve and both work, and only one of them holds a
 * credential anybody has re-entered lately. Refusing them at load would run on
 * every read and take a workspace that has a pair off the air.
 */
describe('duplicateAccountRows', () => {
  test('groups rows that are one account under one provider', () => {
    const duplicated: ConnectionConfig[] = [
      { id: 'con3', provider: 'acme_calendar', account: 'ada@example.com' },
      { id: 'con5', provider: 'acme_mail', account: 'ada@example.com' },
      { id: 'con9', provider: 'acme_mail', account: 'ADA@example.com' },
    ];

    const groups = duplicateAccountRows(duplicated);

    // The calendar is not in it: one account across two providers is the whole
    // point of a vendor family, and only the two mail rows are the same row.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((one) => one.id)).toEqual(['con5', 'con9']);
  });

  test('finds nothing in a workspace where every row is its own account', () => {
    const clean: ConnectionConfig[] = [
      { id: 'con3', provider: 'acme_calendar', account: 'ada@example.com' },
      { id: 'con5', provider: 'acme_mail', account: 'ada@example.com' },
      { id: 'con6', provider: 'acme_mail', account: 'rin@example.com' },
    ];

    expect(duplicateAccountRows(clean)).toEqual([]);
  });
});
