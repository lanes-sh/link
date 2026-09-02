import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import type { ConnectionConfig } from '#profile';
import { ConfigDocument } from '../../config-edit.ts';
import { declareConnection } from './declare.ts';

/**
 * Which lines of the profile a connect writes.
 *
 * The interesting half is `label` against `account`, because the two look alike
 * and are not: one is a name the operator chose and the other is an identity
 * three things read as one. A row that confused them was renameable exactly
 * once, after which `connect` no longer recognised the account it had renamed.
 *
 * A label equal to `defaultLabel` is not written. Every reader derives that
 * string for itself, so recording it would be a line saying what the two lines
 * above it say — the rule that used to be spelled against the account, back
 * when the account was what an unnamed row was called.
 */

const EMPTY = `contract: 5
instance:
  profile: personal
  host: 127.0.0.1
  port: 7400
connections: []
`;

function declaring(connections: readonly ConnectionConfig[], over: Record<string, unknown> = {}) {
  const document = ConfigDocument.fromText(EMPTY);
  const changes = declareConnection({
    document,
    connections,
    providerId: 'gmail',
    connectionId: 'ada',
    account: 'ada@example.com',
    // What `settleIdentity` settles on when the operator presses Enter, and
    // what it hands the writer to compare against.
    label: 'Gmail (ada)',
    defaultLabel: 'Gmail (ada)',
    method: undefined,
    config: {},
    ...over,
    // The cast is what let a missing argument through once already: `config`
    // was passed by `runConnect` and never declared here, so the spread was not
    // excess-property-checked and `tsc` stayed green while the value was
    // dropped on the floor. Kept only for `over`, which is deliberately loose.
  } as Parameters<typeof declareConnection>[0]);

  return { changes, written: parse(document.toString()) as { connections: ConnectionConfig[] } };
}

describe('declaring a new connection', () => {
  test('writes no label when it is the one every reader derives anyway', () => {
    const { written } = declaring([]);

    expect(written.connections[0]).toEqual({
      id: 'ada',
      provider: 'gmail',
      account: 'ada@example.com',
    });
  });

  test('writes one when the operator said something the derived name does not', () => {
    const { written } = declaring([], { label: 'Work mail' });

    expect(written.connections[0]).toEqual({
      id: 'ada',
      provider: 'gmail',
      account: 'ada@example.com',
      label: 'Work mail',
    });
  });
});

describe('reconnecting one that is already declared', () => {
  const declared: ConnectionConfig[] = [
    { id: 'ada', provider: 'gmail', account: 'ada@example.com' },
  ];

  test('changes nothing but says it re-authorised', () => {
    const { changes, written } = declaring(declared);

    expect(changes).toEqual(['re-authorised gmail.ada']);
    // Nothing was set, so the document it was handed is untouched.
    expect(written.connections).toEqual([]);
  });

  test('names the route where the provider offered a choice', () => {
    const { changes } = declaring(declared, { method: 'own_client' });

    expect(changes).toEqual(['re-authorised gmail.ada with own_client']);
  });

  test('keeps the label the operator chose when the account is confirmed again', () => {
    const labelled: ConnectionConfig[] = [
      { id: 'ada', provider: 'gmail', account: 'ada@example.com', label: 'Work mail' },
    ];

    // What `settleIdentity` offers back on a reconnect, accepted by pressing
    // Enter. Re-authorising an expired credential must not undo the name.
    const { changes } = declaring(labelled, { label: 'Work mail' });

    expect(changes).toEqual(['re-authorised gmail.ada']);
  });

  test('records a renamed label as the one change it made', () => {
    const { changes } = declaring(declared, { label: 'Work mail' });

    expect(changes).toEqual(['connections.gmail.ada.label = Work mail', 're-authorised gmail.ada']);
  });
});

describe('a connection that carries where its service is', () => {
  test('writes the address, so the next start can build a connector', () => {
    // The regression this exists for. `connect` prompted for the host, probed
    // the identity through a factory holding it, wrote the row — and the row had
    // no `config`, so every later run found nothing, built no connector, and
    // showed the provider as unconnected. No error anywhere.
    const { written } = declaring([], {
      providerId: 'nextcloud_calendar',
      config: { host: 'cloud.example.com' },
    });

    expect(written.connections[0]).toMatchObject({
      id: 'ada',
      provider: 'nextcloud_calendar',
      config: { host: 'cloud.example.com' },
    });
  });

  test('a provider with no address writes no config key at all', () => {
    expect(written(declaring([]))).not.toHaveProperty('config');
  });

  test('a reconnect updates an address that moved, and says so', () => {
    // A self-hosted service moving is exactly why somebody reconnects, and a
    // row left pointing at the old host sends the credential there.
    const { changes, written: after } = declaring(
      [
        {
          id: 'ada',
          provider: 'nextcloud_calendar',
          account: 'ada@example.com',
          config: { host: 'old.example.com' },
        } as ConnectionConfig,
      ],
      { providerId: 'nextcloud_calendar', config: { host: 'new.example.com' } },
    );

    expect(after.connections[0]?.config).toEqual({ host: 'new.example.com' });
    expect(changes).toContain('connections.nextcloud_calendar.ada.config.host = new.example.com');
  });
});

/** The first row, for the assertions that only care about one. */
function written(result: { written: { connections: ConnectionConfig[] } }): ConnectionConfig {
  return result.written.connections[0]!;
}
