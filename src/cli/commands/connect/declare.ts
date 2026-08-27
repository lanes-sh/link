import type { ConnectionConfig } from '#profile';
import type { ConfigDocument } from '../../config-edit.ts';

/**
 * Writing the connection row — the one edit `connect` makes to the profile.
 *
 * Its own file because it answers its own question: given an account, an id and
 * a name, which lines of YAML change? The five numbered steps around it are
 * about vendors, browsers and credential stores, and none of that reaches here.
 *
 * Two fields, and the difference between them is the whole subject. `account` is
 * an identity the provider reported, and three things read it as one — the
 * reconnect match in `settleIdentity`, the id derived from it, and the `From`
 * header `gmail.send_message` writes. `label` is what the operator calls the
 * same row, addressed by nothing and displayed everywhere.
 */
export function declareConnection(input: {
  readonly document: ConfigDocument;
  /** The profile as it stands, which says whether this is an add or a repair. */
  readonly connections: readonly ConnectionConfig[];
  readonly providerId: string;
  readonly connectionId: string;
  readonly account: string;
  readonly label: string;
  /** Which route in, where the provider offered a choice. */
  readonly method: string | undefined;
}): readonly string[] {
  const { document, connections, providerId, connectionId, account, label, method } = input;

  const key = `${providerId}.${connectionId}`;
  const index = connections.findIndex((c) => `${c.provider}.${c.id}` === key);
  const changes: string[] = [];

  if (index === -1) {
    // No `credential_ref`: it derives to `<provider>/<id>`, which is exactly
    // where the OAuth provider already looks. Writing it would add a line per
    // connection that can only ever agree or be a bug.
    //
    // No `label` either, when it is the account. Pressing Enter at the prompt is
    // the common answer, and a line repeating the address above it is a line to
    // read past forever.
    document.addTo(['connections'], {
      id: connectionId,
      provider: providerId,
      account,
      ...(label === account ? {} : { label }),
    });
    changes.push(`connections += ${key} (${account})`);
    return changes;
  }

  // A reconnect. The credential was just replaced; the declaration stays as it
  // is, so re-running connect after an expiry is a no-op on the file rather than
  // a second row.
  const declared = connections[index];

  if (declared?.account !== account) {
    document.setIn(['connections', index, 'account'], account);
    changes.push(`connections.${key}.account = ${account}`);
  }

  // Compared against what the row is *called*, which is the account until
  // somebody names it otherwise. Without the fallback, every reconnect of an
  // unlabelled connection writes a label that says what the line above it says.
  if ((declared?.label ?? declared?.account) !== label) {
    document.setIn(['connections', index, 'label'], label);
    changes.push(`connections.${key}.label = ${label}`);
  }

  // Named where the provider offered a choice, because this is the line an
  // operator reads to see that a re-connect swapped the route rather than
  // refreshed it — and `--auth` reaches here having asked nothing. Unnamed for a
  // provider with one way in, whose output is unchanged.
  changes.push(`re-authorised ${key}${method ? ` with ${method}` : ''}`);
  return changes;
}
