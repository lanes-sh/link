import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESERVED_PROVIDER_IDS } from '#connectivity';
import type { ProviderManifest } from '#connectivity';
import {
  CONNECTIONS_FILE,
  parseConfig,
  readConnections,
  type Config,
  type ConnectionConfig,
} from '#profile';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { planAll } from '#providers/setup/plan.ts';
import { createProfile } from './profile.ts';
import { connectionsSharingCredential, removeConnection } from './connection.ts';
import { renameConnection } from './relabel.ts';

/**
 * `lanes link disconnect` and `lanes link relabel`.
 *
 * Three properties, and only the first is the obvious one.
 *
 * **The edit is surgical.** Both go through `ConfigDocument`, so an operator's
 * comments and key order survive. A CLI that reformats the file on every edit
 * makes the file hostile to hand-editing, which then makes the CLI mandatory.
 *
 * **A shared credential is not collateral.** A reference is per connection for an
 * OAuth provider and *shared* for a manifest declaring `credential_ref`. Deleting
 * one while a sibling still resolves to it takes the sibling's credential with
 * it, and the sibling then reports `unauthorized` for a `connect` nobody ran.
 *
 * **The owner layer is refused.** `memory` and its siblings hold no credential and
 * are granted by a policy line this command does not touch, so removing the
 * connection alone leaves the policy granting against nothing.
 */

const WHERE = { profile: 'personal', target: 'local' } as const;

// Only the accounts. The owner layer is not declared here: a fresh workspace
// arrives with `memory.main` and its siblings already in `connections.yaml`
// (ADR-050, ADR-059), and declaring one of them a second time is a duplicate the
// parser refuses — which would fail every test in this file for a reason none of
// them is about.
const CONNECTIONS = `
  - { id: main, provider: gmail, account: first@example.com }
  - { id: side, provider: gmail, account: second@example.com }
`;

/** The grants a profile needs to reach the two accounts above. */
const GRANTS = `
  - { connection: gmail.main, allow: [gmail.*], deny: [] }
  - { connection: gmail.side, allow: [gmail.*], deny: [] }
`;

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-connection-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await createProfile('personal', { targets: ['local'] });

  // Declared by hand rather than through `connect`, which would want a browser
  // and a real Google account. Two files now: the account belongs to the
  // workspace and the permission to use it to the profile (ADR-057).
  const connections = join(root, CONNECTIONS_FILE);
  const held = await Bun.file(connections).text();
  await Bun.write(connections, held.replace('connections:', `connections:${CONNECTIONS}`));

  const path = join(root, 'profiles', 'personal.yaml');
  const text = await Bun.file(path).text();
  await Bun.write(path, text.replace('grants:', `grants:${GRANTS}`));
  return root;
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function onDisk(root: string): Promise<Config> {
  const text = await Bun.file(join(root, 'profiles', 'personal.yaml')).text();
  return parseConfig(text).config;
}

/** What the workspace holds, which is where a connection lives now. */
async function held(root: string): Promise<string[]> {
  return (await readConnections(root)).connections.map((one) => `${one.provider}.${one.id}`);
}

/** What the profile grants, which is a different question. */
function keys(config: Config): string[] {
  return config.grants.map((grant) => grant.connection);
}

describe('disconnect', () => {
  test('removes the declaration and leaves its neighbours alone', async () => {
    const root = await workspace();

    const outcome = await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect(outcome).not.toBeNull();
    expect(outcome!.disconnected.key).toBe('gmail.side');
    expect(outcome!.disconnected.account).toBe('second@example.com');
    expect(await held(root)).not.toContain('gmail.side');
    expect(await held(root)).toContain('gmail.main');
    expect(await held(root)).toContain('memory.main');
    // And the grant that named it goes with it.
    expect(keys(await onDisk(root))).not.toContain('gmail.side');
  });

  test('keeps the operator’s comments', async () => {
    const root = await workspace();
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    const text = await Bun.file(join(root, 'profiles', 'personal.yaml')).text();
    // The template's own commentary, which a reformatting writer would drop.
    expect(text).toContain('# One row per connection this profile may reach');
  });

  test('reports the credential it deleted', async () => {
    await workspace();
    const outcome = await removeConnection('gmail.side', { ...WHERE, yes: true });

    // OAuth derives `<provider>/<id>`, so this one is per connection.
    expect(outcome!.disconnected.credential).toBe('gmail/side');
    expect(outcome!.disconnected.credentialSharedWith).toEqual([]);
  });

  test('leaves the credential alone when asked to', async () => {
    await workspace();
    const outcome = await removeConnection('gmail.side', {
      ...WHERE,
      yes: true,
      keepCredential: true,
    });

    expect(outcome!.disconnected.credential).toBeNull();
    // The declaration still goes; only the secret stays.
    expect(await held(roots[roots.length - 1]!)).not.toContain('gmail.side');
  });

  test('refuses a bare provider, and says which connections it has', async () => {
    await workspace();

    // Nothing to choose: `connect gmail` can create an account and pick the id,
    // but a `disconnect gmail` with two declared would be guessing which to throw
    // away.
    await expect(removeConnection('gmail', { ...WHERE, yes: true })).rejects.toThrow(
      /names a provider, not a connection[\s\S]*gmail\.main, gmail\.side/,
    );
  });

  test('refuses a key the workspace does not hold', async () => {
    await workspace();
    await expect(removeConnection('gmail.nope', { ...WHERE, yes: true })).rejects.toThrow(
      /holds no connection "gmail\.nope"/,
    );
  });

  test('refuses the last instance of a built-in, and says to deny it instead', async () => {
    // Not a blanket refusal any more. An owner-layer surface is a connection
    // like any other (ADR-059), so a second instance can be disconnected; the
    // *last* one cannot, because `ensureOwnerLayer` puts it back on the next
    // command and a success line the next command undoes is worse than a
    // refusal.
    const root = await workspace();

    await expect(removeConnection('memory.main', { ...WHERE, yes: true })).rejects.toThrow(
      /only memory connection[\s\S]*policy deny/,
    );
    // And refuses before writing anything.
    expect(await held(root)).toContain('memory.main');
  });

  test('a second instance of a built-in disconnects normally', async () => {
    const root = await workspace();
    const connections = join(root, CONNECTIONS_FILE);
    const text = await Bun.file(connections).text();
    await Bun.write(
      connections,
      text.replace('connections:', 'connections:\n  - { id: work, provider: memory, account: Memory }'),
    );

    const outcome = await removeConnection('memory.work', { ...WHERE, yes: true });

    expect(outcome!.disconnected.key).toBe('memory.work');
    expect(await held(root)).not.toContain('memory.work');
    expect(await held(root)).toContain('memory.main');
  });

  // Every reserved id, so one added to `RESERVED_PROVIDER_IDS` is covered here
  // the moment it exists rather than the next time somebody remembers.
  test.each([...RESERVED_PROVIDER_IDS])('refuses the last %s', async (provider) => {
    const root = await workspace();
    const connections = join(root, CONNECTIONS_FILE);
    const text = await Bun.file(connections).text();
    // The template already holds every reserved id but `identity`; declaring one
    // twice is a config the parser refuses, which would fail this for the wrong
    // reason.
    if (!text.includes(`provider: ${provider}`)) {
      await Bun.write(
        connections,
        text.replace('connections:', `connections:\n  - { id: main, provider: ${provider}, account: X }`),
      );
    }

    await expect(removeConnection(`${provider}.main`, { ...WHERE, yes: true })).rejects.toThrow(
      /is the only .* connection in this workspace/,
    );
  });

  test('refuses without --yes when there is nobody to ask', async () => {
    // stdin is not a terminal under the test runner, so this is the real path a
    // script hits.
    const root = await workspace();
    await expect(removeConnection('gmail.side', WHERE)).rejects.toThrow(/Pass --yes/);
    expect(await held(root)).toContain('gmail.side');
  });
});

describe('a credential two connections resolve to', () => {
  const shared: ProviderManifest = {
    id: 'shared',
    name: 'Shared',
    description: '',
    auth: { kind: 'api_key', credential_ref: 'shared/key' },
    capabilities: [],
  } as unknown as ProviderManifest;

  // Rows, not a profile. The accounts belong to the workspace now (ADR-057),
  // and this check is about which of them resolve to one credential reference.
  const rows: ConnectionConfig[] = [
    { id: 'one', provider: 'shared', account: 'a' },
    { id: 'two', provider: 'shared', account: 'b' },
  ];

  test('is named, not deleted', () => {
    // The whole reason the check exists: a manifest-level `credential_ref` is one
    // reference for every connection of that provider.
    const found = connectionsSharingCredential(rows, 'shared/key', 0, () => shared);
    expect(found).toEqual(['shared.two']);
  });

  test('is deleted once nothing else resolves to it', () => {
    expect(connectionsSharingCredential([rows[0]!], 'shared/key', 0, () => shared)).toEqual([]);
  });

  test('does not confuse two OAuth connections, whose refs differ', () => {
    const oauth = {
      id: 'gmail',
      name: 'Gmail',
      description: '',
      auth: { kind: 'oauth' },
      capabilities: [],
    } as unknown as ProviderManifest;
    const two: ConnectionConfig[] = [
      { id: 'main', provider: 'gmail', account: 'a' },
      { id: 'side', provider: 'gmail', account: 'b' },
    ];

    expect(connectionsSharingCredential(two, 'gmail/main', 0, () => oauth)).toEqual([]);
  });
});

describe('relabel', () => {
  test('changes what an account is called', async () => {
    const root = await workspace();

    const { relabelled } = await renameConnection('gmail.main', 'Work Mail', WHERE);

    expect(relabelled.from).toBe('first@example.com');
    expect(relabelled.to).toBe('Work Mail');
    const rows = (await readConnections(root)).connections;
    expect(rows.find((one) => one.provider === 'gmail' && one.id === 'main')?.label)
      .toBe('Work Mail');
  });

  /**
   * The bug this command shipped with.
   *
   * Renaming wrote the operator's words over `account`, and `account` is an
   * identity: `settleIdentity` matches on it to decide a `connect` is a repair,
   * `idFromAccount` derives the id from it, and `gmail.send_message` puts it in
   * a `From` header. So `relabel gmail.main "Work Mail"` left a row that the
   * next `connect gmail` no longer recognised — it appended `gmail.first`
   * alongside — and a mailbox that could no longer set a display name when it
   * sent. The label is a separate field for exactly this reason.
   */
  test('leaves the identity it renames alone', async () => {
    const root = await workspace();

    await renameConnection('gmail.main', 'Work Mail', WHERE);

    const rows = (await readConnections(root)).connections;
    expect(rows.find((one) => one.provider === 'gmail' && one.id === 'main')?.account)
      .toBe('first@example.com');
  });

  test('touches nothing else', async () => {
    const root = await workspace();
    await renameConnection('gmail.main', 'Work Mail', WHERE);

    expect(keys(await onDisk(root))).toContain('gmail.side');

    const rows = (await readConnections(root)).connections;
    expect(rows.find((one) => one.id === 'side')?.account).toBe('second@example.com');
    expect(rows.find((one) => one.id === 'side')?.label).toBeUndefined();
  });

  test('reports the label it replaced, not the account, once there is one', async () => {
    await workspace();
    await renameConnection('gmail.main', 'Work Mail', WHERE);

    const { relabelled } = await renameConnection('gmail.main', 'Day job', WHERE);

    expect(relabelled.from).toBe('Work Mail');
    expect(relabelled.to).toBe('Day job');
  });

  test('is allowed for the owner layer, which has a label like anything else', async () => {
    // Unlike disconnect: a display name is harmless to change, and "Memory" is
    // the operator's word for their own store.
    const root = await workspace();
    await renameConnection('memory.main', 'My notes', WHERE);

    const rows = (await readConnections(root)).connections;
    expect(rows.find((one) => one.provider === 'memory')?.label).toBe('My notes');
  });

  test('refuses a key the workspace does not hold', async () => {
    await workspace();
    await expect(renameConnection('gmail.nope', 'X', WHERE)).rejects.toThrow(/holds no connection/);
  });
});

describe('the plan reports which providers are reserved', () => {
  const context = { profile: 'personal', target: 'local', connections: [] };

  test('is exactly the owner layer among the shipped manifests', () => {
    const plans = planAll(PROVIDER_MANIFESTS, context as never);
    const reserved = plans.filter((one) => one.reserved).map((one) => one.id);

    // The shipped third-party set contains none of them, which is the point of
    // the reserved list: a manifest cannot claim one of those ids.
    expect(reserved).toEqual([]);
  });

  test('does not confuse `auth: none` with the owner layer', () => {
    // `icloud_drive` is `auth: none` because Apple exposes a synced folder rather
    // than a protocol. A surface grouping on `multiAccount` would file it with
    // memory and skills, which is what `reserved` exists to prevent.
    const plans = planAll(PROVIDER_MANIFESTS, context as never);
    const drive = plans.find((one) => one.id === 'icloud_drive');

    expect(drive?.multiAccount).toBe(false);
    expect(drive?.reserved).toBe(false);
  });
});

/**
 * The grant goes with the connection, because it *is* the connection.
 *
 * The bug this replaced: `assertReferentialIntegrity` refused an allow rule
 * naming a provider with no connection, and `removeConnection` saves through
 * `validateConfig` — so disconnecting the last account of a provider failed, on
 * a policy line the operator had not touched, and removed nothing. Every
 * single-account provider was undisconnectable, which is most of them.
 *
 * That state is now unrepresentable. A grant names its connection (ADR-058), so
 * "the rule that outlived its account" is not a thing a file can say, and the
 * hunting `dropProviderRules` did — find every rule whose capability begins
 * `gmail.`, decide whether each is now dangling — collapsed into removing one
 * row.
 */
describe('disconnecting the last connection of a provider', () => {
  test('works at all, which is the whole of the bug', async () => {
    const root = await workspace();

    await removeConnection('gmail.main', { ...WHERE, yes: true });
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect((await held(root)).filter((key) => key.startsWith('gmail.'))).toEqual([]);
    expect(keys(await onDisk(root)).filter((key) => key.startsWith('gmail.'))).toEqual([]);
  });

  test('leaves the sibling grant while the sibling is still there', async () => {
    const root = await workspace();
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect(keys(await onDisk(root))).toContain('gmail.main');
    expect(keys(await onDisk(root))).not.toContain('gmail.side');
  });

  test('reports which profiles lost a grant', async () => {
    // A connection belongs to the workspace, so disconnecting one reaches every
    // profile that named it — including profiles the operator was not thinking
    // about. Naming them is the whole point of computing this before asking.
    const root = await workspace();
    const outcome = await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect(outcome!.disconnected.ungranted).toEqual(['personal']);
    expect(await held(root)).not.toContain('gmail.side');
  });

  test('a connection nothing grants still disconnects, and says nobody lost it', async () => {
    const root = await workspace();
    const connections = join(root, CONNECTIONS_FILE);
    const text = await Bun.file(connections).text();
    await Bun.write(
      connections,
      text.replace('connections:', 'connections:\n  - { id: spare, provider: gmail, account: third@example.com }'),
    );

    const outcome = await removeConnection('gmail.spare', { ...WHERE, yes: true });

    expect(outcome!.disconnected.ungranted).toEqual([]);
    expect(await held(root)).not.toContain('gmail.spare');
  });
});
