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
 */

const EMPTY = `contract: 2
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
    label: 'ada@example.com',
    method: undefined,
    ...over,
  } as Parameters<typeof declareConnection>[0]);

  return { changes, written: parse(document.toString()) as { connections: ConnectionConfig[] } };
}

describe('declaring a new connection', () => {
  test('writes no label when the label is only the account again', () => {
    const { written } = declaring([]);

    expect(written.connections[0]).toEqual({
      id: 'ada',
      provider: 'gmail',
      account: 'ada@example.com',
    });
  });

  test('writes one when the operator said something the account does not', () => {
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
