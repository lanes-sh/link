import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESERVED_PROVIDER_IDS } from '#connectivity';
import type { ProviderManifest } from '#connectivity';
import { parseConfig, type Config } from '#profile';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { planAll } from '#providers/setup/plan.ts';
import { createProfile } from './profile.ts';
import { connectionsSharingCredential, removeConnection, renameConnection } from './connection.ts';

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

// Only the accounts. The owner layer is not declared here: a fresh profile
// arrives with `memory.main` and its siblings already granted (ADR-050), and
// declaring one of them a second time is a duplicate the parser refuses — which
// would fail every test in this file for a reason none of them is about.
const CONNECTIONS = `
  - id: main
    provider: gmail
    account: first@example.com
  - id: side
    provider: gmail
    account: second@example.com
`;

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-connection-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;
  await createProfile('personal', { targets: ['local'] });

  // Declared by hand rather than through `connect`, which would want a browser
  // and a real Google account.
  const path = join(root, 'profiles', 'personal.yaml');
  const text = await Bun.file(path).text();
  await Bun.write(path, text.replace('connections:', `connections:${CONNECTIONS}`));
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

function keys(config: Config): string[] {
  return config.connections.map((one) => `${one.provider}.${one.id}`);
}

describe('disconnect', () => {
  test('removes the declaration and leaves its neighbours alone', async () => {
    const root = await workspace();

    const outcome = await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect(outcome).not.toBeNull();
    expect(outcome!.disconnected.key).toBe('gmail.side');
    expect(outcome!.disconnected.account).toBe('second@example.com');
    expect(keys(await onDisk(root))).not.toContain('gmail.side');
    expect(keys(await onDisk(root))).toContain('gmail.main');
    expect(keys(await onDisk(root))).toContain('memory.main');
  });

  test('keeps the operator’s comments', async () => {
    const root = await workspace();
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    const text = await Bun.file(join(root, 'profiles', 'personal.yaml')).text();
    // The template's own commentary, which a reformatting writer would drop.
    expect(text).toContain('# One entry per authorised account');
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
    expect(keys(await onDisk(await roots[roots.length - 1]!))).not.toContain('gmail.side');
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

  test('refuses a key the profile does not declare', async () => {
    await workspace();
    await expect(removeConnection('gmail.nope', { ...WHERE, yes: true })).rejects.toThrow(
      /does not declare "gmail\.nope"/,
    );
  });

  test('refuses the owner layer, and says to edit the file', async () => {
    const root = await workspace();

    await expect(removeConnection('memory.main', { ...WHERE, yes: true })).rejects.toThrow(
      /part of what this profile is[\s\S]*by hand/,
    );
    // And refuses before writing anything.
    expect(keys(await onDisk(root))).toContain('memory.main');
  });

  // Every reserved id, so one added to `RESERVED_PROVIDER_IDS` is covered here
  // the moment it exists rather than the next time somebody remembers.
  test.each([...RESERVED_PROVIDER_IDS])('refuses %s', async (provider) => {
    const root = await workspace();
    const path = join(root, 'profiles', 'personal.yaml');
    const text = await Bun.file(path).text();
    // The template already declares every reserved id but `identity`; declaring
    // one twice is a config the parser refuses, which would fail this for the
    // wrong reason.
    if (!text.includes(`provider: ${provider}`)) {
      await Bun.write(
        path,
        text.replace('connections:', `connections:\n  - id: main\n    provider: ${provider}\n    account: X\n`),
      );
    }

    await expect(removeConnection(`${provider}.main`, { ...WHERE, yes: true })).rejects.toThrow(
      /part of what this profile is/,
    );
  });

  test('refuses without --yes when there is nobody to ask', async () => {
    // stdin is not a terminal under the test runner, so this is the real path a
    // script hits.
    const root = await workspace();
    await expect(removeConnection('gmail.side', WHERE)).rejects.toThrow(/Pass --yes/);
    expect(keys(await onDisk(root))).toContain('gmail.side');
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

  const config = {
    connections: [
      { id: 'one', provider: 'shared', account: 'a' },
      { id: 'two', provider: 'shared', account: 'b' },
    ],
  } as unknown as Config;

  test('is named, not deleted', () => {
    // The whole reason the check exists: a manifest-level `credential_ref` is one
    // reference for every connection of that provider.
    const found = connectionsSharingCredential(config, 'shared/key', 0, () => shared);
    expect(found).toEqual(['shared.two']);
  });

  test('is deleted once nothing else resolves to it', () => {
    const only = { connections: [config.connections[0]] } as unknown as Config;
    expect(connectionsSharingCredential(only, 'shared/key', 0, () => only && shared)).toEqual([]);
  });

  test('does not confuse two OAuth connections, whose refs differ', () => {
    const oauth = {
      id: 'gmail',
      name: 'Gmail',
      description: '',
      auth: { kind: 'oauth' },
      capabilities: [],
    } as unknown as ProviderManifest;
    const two = {
      connections: [
        { id: 'main', provider: 'gmail', account: 'a' },
        { id: 'side', provider: 'gmail', account: 'b' },
      ],
    } as unknown as Config;

    expect(connectionsSharingCredential(two, 'gmail/main', 0, () => oauth)).toEqual([]);
  });
});

describe('relabel', () => {
  test('changes what an account is called', async () => {
    const root = await workspace();

    const { relabelled } = await renameConnection('gmail.main', 'Work Mail', WHERE);

    expect(relabelled.from).toBe('first@example.com');
    expect(relabelled.to).toBe('Work Mail');
    const config = await onDisk(root);
    expect(config.connections.find((c) => c.provider === 'gmail' && c.id === 'main')?.account)
      .toBe('Work Mail');
  });

  test('touches nothing else', async () => {
    const root = await workspace();
    await renameConnection('gmail.main', 'Work Mail', WHERE);

    const config = await onDisk(root);
    expect(keys(config)).toContain('gmail.side');
    expect(config.connections.find((c) => c.id === 'side')?.account).toBe('second@example.com');
  });

  test('is allowed for the owner layer, which has a label like anything else', async () => {
    // Unlike disconnect: a display name is harmless to change, and "Memory" is
    // the operator's word for their own store.
    const root = await workspace();
    await renameConnection('memory.main', 'My notes', WHERE);

    const config = await onDisk(root);
    expect(config.connections.find((c) => c.provider === 'memory')?.account).toBe('My notes');
  });

  test('refuses a key the profile does not declare', async () => {
    await workspace();
    await expect(renameConnection('gmail.nope', 'X', WHERE)).rejects.toThrow(/does not declare/);
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
 * The rule goes with the last connection that justified it.
 *
 * Not a tidiness feature. `assertReferentialIntegrity` refuses an allow rule
 * naming a provider with no connection, and `removeConnection` saves through
 * `validateConfig` — so disconnecting the last account of a provider failed, on
 * a policy line the operator had not touched, and removed nothing. Every
 * single-account provider was undisconnectable, which is most of them.
 */
describe('disconnecting the last connection of a provider', () => {
  /** The policy line itself — the template's comments quote `allow: [` too. */
  const POLICY = 'allow: [memory.*';

  /** The fixture's profile, plus the `gmail.*` rule `connect` would have written. */
  async function granted(): Promise<string> {
    const root = await workspace();
    const path = join(root, 'profiles', 'personal.yaml');
    const text = await Bun.file(path).text();
    await Bun.write(path, text.replace(POLICY, 'allow: [gmail.*, gmail.send_message, memory.*'));
    return root;
  }

  test('works at all, which is the whole of the bug', async () => {
    // It did not. `save` validates, and the loader refuses an allow rule naming
    // a provider with no connection — so removing the last Gmail failed on a
    // policy line the operator had not touched, and removed nothing.
    const root = await granted();

    await removeConnection('gmail.main', { ...WHERE, yes: true });
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    const config = await onDisk(root);
    expect(keys(config).filter((key) => key.startsWith('gmail.'))).toEqual([]);
    expect(config.policy.allow.map((rule) => rule.capability)).not.toContain('gmail.*');
  });

  test('leaves the rule while a sibling still needs it', async () => {
    const root = await granted();
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect((await onDisk(root)).policy.allow.map((rule) => rule.capability)).toContain('gmail.*');
  });

  test('never touches a blanket allow, which names no provider', async () => {
    const root = await workspace();
    const path = join(root, 'profiles', 'personal.yaml');
    await Bun.write(path, (await Bun.file(path).text()).replace(POLICY, "allow: ['*', memory.*"));

    await removeConnection('gmail.main', { ...WHERE, yes: true });
    await removeConnection('gmail.side', { ...WHERE, yes: true });

    expect((await onDisk(root)).policy.allow.map((rule) => rule.capability)).toContain('*');
  });
});
