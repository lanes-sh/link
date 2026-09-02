import { describe, expect, test } from 'bun:test';
import { accountsByProfile, describeWithConnections } from './visibility.ts';
import type { BuildServerOptions, ProfileRuntime } from './visibility.ts';

/**
 * That a caller can tell two accounts of one vendor apart.
 *
 * The `connection` argument is an enum of ids, and an id is all a model has to
 * choose on. `idFromAccount` takes only the local part of an address, so
 * `ada.lovelace@example.com` and `ada.lovelace@example.org` become
 * `ada_lovelace` and `ada_lovelace2` — two mailboxes, and nothing anywhere
 * saying which is which. Picking the wrong one sends mail as the wrong person.
 *
 * The same rule ADR-056 states for entities: ordering is not selection, and a
 * caller that cannot tell two candidates apart must be given what tells them
 * apart. Here that is the account, and the label where there is one.
 */

const connection = (id: string, account: string, label?: string) => ({
  ref: `gmail.${id}`,
  connection: { id, provider: 'gmail', account, ...(label === undefined ? {} : { label }) },
  grant: { connection: `gmail.${id}`, allow: [], deny: [] },
});

const options = (connections: readonly ReturnType<typeof connection>[]): BuildServerOptions =>
  ({
    profiles: new Map<string, ProfileRuntime>([
      ['personal', { connections } as unknown as ProfileRuntime],
    ]),
  }) as unknown as BuildServerOptions;

describe('the connection argument says which account it is', () => {
  test('two ids that differ by a digit carry the addresses that differ by a domain', () => {
    const described = describeWithConnections(
      'Read a message.',
      new Map([['personal', ['ada_lovelace', 'ada_lovelace2']]]),
      accountsByProfile(
        options([
          connection('ada_lovelace', 'ada.lovelace@example.com'),
          connection('ada_lovelace2', 'ada.lovelace@example.org'),
        ]),
      ),
    );

    expect(described).toContain('ada_lovelace — ada.lovelace@example.com');
    expect(described).toContain('ada_lovelace2 — ada.lovelace@example.org');
  });

  test("the operator's label comes too, where they set one", () => {
    const described = describeWithConnections(
      'Read a message.',
      new Map([['personal', ['ada_lovelace']]]),
      accountsByProfile(options([connection('ada_lovelace', 'ada.lovelace@example.com', 'Work')])),
    );

    expect(described).toContain('ada_lovelace — ada.lovelace@example.com (Work)');
  });

  test('grouped by profile, because the two arguments are not independent', () => {
    // `profile: personal` with a connection belonging to `work` is refused, so a
    // flat list would read as though any pairing were valid.
    const described = describeWithConnections(
      'Read a message.',
      new Map([
        ['personal', ['ada_lovelace']],
        ['work', ['rin_shaw']],
      ]),
      new Map(),
    );

    expect(described).toContain('  personal:\n    ada_lovelace');
    expect(described).toContain('  work:\n    rin_shaw');
  });

  test('an account nobody resolved is still listed, by its id alone', () => {
    // A harness that builds a registry to read manifests has no selection to
    // join against. Degrading to what this showed everybody before beats
    // omitting the connection from its own enum's description.
    const described = describeWithConnections(
      'Read a message.',
      new Map([['personal', ['ada_lovelace']]]),
      new Map(),
    );

    expect(described).toContain('ada_lovelace');
    expect(described).not.toContain('—');
  });
});
