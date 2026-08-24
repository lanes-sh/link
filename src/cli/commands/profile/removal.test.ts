import { describe, expect, test } from 'bun:test';
import type { Config, TargetConfig } from '#profile';
import { buildRegistry } from '../../runtime/registry.ts';
import { declaredRefs } from './removal.ts';

/**
 * Which credentials a profile may have its removal delete.
 *
 * The question only looks trivial on a local target, where the profile owns a
 * file and the file is the boundary. In Secret Manager every profile deployed
 * to one project shares a flat namespace, so `list()` answers with other
 * profiles' credentials too — and deleting those is not recoverable.
 */

const registry = buildRegistry();

const target = (over: Partial<TargetConfig> = {}): TargetConfig =>
  ({
    credentials: { adapter: 'file' },
    storage: { adapter: 'filesystem' },
    ...over,
  }) as unknown as TargetConfig;

const config = (over: Partial<Config> = {}): Config =>
  ({
    contract: 1,
    instance: { profile: 'personal', default_target: 'local' },
    auth: { mode: 'bearer', token_ref: 'profile/token' },
    oauth_apps: {
      google: { client_id_ref: 'google/client_id', client_secret_ref: 'google/client_secret' },
    },
    connections: [{ id: 'someone', provider: 'gmail', account: 'someone@example.com' }],
    targets: { local: target() },
    policy: { allow: [] },
    ...over,
  }) as unknown as Config;

describe('declaredRefs', () => {
  test('covers the profile token, the connection, and the oauth client', () => {
    const refs = declaredRefs(config(), registry, target());

    expect(refs).toContain('profile/token');
    expect(refs).toContain('gmail/someone');
    expect(refs).toContain('google/client_id');
    expect(refs).toContain('google/client_secret');
  });

  test('the vault ref comes from the target, because that is where it is declared', () => {
    // `vaultTargetSchema` sits inside `targetSchema`. Two targets may seal the
    // same profile's items in different places, so reading this off the profile
    // would attach one target's vault to another's removal.
    const sealed = target({ vault: { adapter: 'secret', ref: 'vault/document' } } as never);

    expect(declaredRefs(config(), registry, sealed)).toContain('vault/document');
    expect(declaredRefs(config(), registry, target())).not.toContain('vault/document');
  });

  test('a secret adapter with no ref falls back to the documented default', () => {
    const sealed = target({ vault: { adapter: 'secret' } } as never);

    expect(declaredRefs(config(), registry, sealed)).toContain('vault/document');
  });

  test('a connection whose provider no longer resolves contributes nothing', () => {
    // Its secret is reported as untouched rather than guessed at. A guessed
    // `<provider>/<id>` in a shared namespace could name someone else's.
    const gone = config({
      connections: [{ id: 'x', provider: 'no_such_provider', account: 'x' }],
    } as never);

    const refs = declaredRefs(gone, registry, target());

    expect(refs).not.toContain('no_such_provider/x');
    expect(refs).toContain('profile/token');
  });

  test('an explicit credential_ref still counts when the manifest is gone', () => {
    // `credentialRefFor` is the single authority: the manifest answers first,
    // and the connection's own field is the answer when it gives none.
    const explicit = config({
      connections: [
        { id: 'x', provider: 'no_such_provider', account: 'x', credential_ref: 'mything/api_key' },
      ],
    } as never);

    expect(declaredRefs(explicit, registry, target())).toContain('mything/api_key');
  });

  test('returns each ref once, even when two connections share a client', () => {
    const two = config({
      connections: [
        { id: 'a', provider: 'gmail', account: 'a@example.com' },
        { id: 'b', provider: 'drive', account: 'b@example.com' },
      ],
    } as never);

    const refs = declaredRefs(two, registry, target());

    expect(refs.filter((ref) => ref === 'google/client_id')).toHaveLength(1);
    expect(refs).toContain('gmail/a');
    expect(refs).toContain('drive/b');
  });
});
