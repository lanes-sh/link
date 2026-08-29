import { describe, expect, test } from 'bun:test';
import { DEPLOY_DEFAULTS } from './schema.ts';
import { noTargetNamed, notInRegistry, requireTarget, type Registry } from './targets.ts';

/**
 * Which target a command acts on.
 *
 * `--target`, or it does not run. What used to be tested here was a precedence
 * chain — flag, then `LANES_LINK_TARGET`, then `instance.default_target` — and
 * those cases are gone rather than inverted, because the thing they described
 * no longer exists (ADR-037). What is left is worth more: that a command naming
 * nothing is refused with the list, and that the refusal names the one thing an
 * operator is most likely to still be looking at.
 *
 * The list itself moved under ADR-052. It was one profile's `targets:` block,
 * which meant "is `cloud` declared" had a different answer per profile; it is
 * the workspace registry now, so there is one list and it is read before any
 * profile is.
 */

const declared = (name: string, deploy = false): Registry[string] => ({
  credentials: { adapter: 'file' },
  storage: { adapter: 'filesystem' },
  ...(deploy
    ? {
        deploy: {
          platform: 'cloudrun' as const,
          region: 'r',
          service: 's',
          access: 'iam' as const,
          min_instances: 0,
          ...DEPLOY_DEFAULTS,
        },
      }
    : {}),
});

const twoTargets: Registry = {
  local: declared('local'),
  cloud: { workspace: 'gs://your-bucket' },
};

const localOnly: Registry = { local: declared('local') };

const twoDeployable: Registry = {
  cloud: declared('cloud', true),
  staging: declared('staging', true),
};

describe('target resolution', () => {
  test('a named target is the target', () => {
    expect(requireTarget(twoTargets, 'cloud')).toBe('cloud');
    expect(requireTarget(twoTargets, 'local')).toBe('local');
  });

  test('naming none is refused, with what there is to choose from', () => {
    // The case the whole change exists for. Falling back here is what let an
    // ignored `--target` produce a working command and surface one command
    // later, detached from its cause.
    expect(() => requireTarget(twoTargets, undefined)).toThrow('--target is required');
    expect(() => requireTarget(twoTargets, undefined)).toThrow('local');
    expect(() => requireTarget(twoTargets, undefined)).toThrow('cloud');
  });

  test('the listing says where each target lives', () => {
    // Here-versus-elsewhere is what distinguishes two entries, and following a
    // pointer to find out would be a network call inside a refusal.
    const message = noTargetNamed(twoTargets, '/ws', {}).message;

    expect(message).toContain('gs://your-bucket');
    expect(message).toContain('here');
  });

  test('the refusal names an exported variable that no longer resolves', () => {
    // The single most confusing state during the change: a shell still
    // configured for the old world, where nothing on screen says the variable
    // stopped counting. Self-limiting — it disappears when the variable does.
    const message = noTargetNamed(twoTargets, '/ws', { LANES_LINK_TARGET: 'cloud' }).message;

    expect(message).toContain('LANES_LINK_TARGET=cloud');
    expect(message).toContain('no longer read');
  });

  test('and says nothing about it when it is not set', () => {
    expect(noTargetNamed(twoTargets, '/ws', {}).message).not.toContain('LANES_LINK_TARGET');
  });

  test('an empty registry says how to make one rather than listing nothing', () => {
    const message = noTargetNamed({}, '/ws', {}).message;

    expect(message).toContain('declares none');
    expect(message).toContain('lanes link profile add');
  });

  test('a target the registry does not hold is a typo, and the list is the answer', () => {
    expect(() => requireTarget(twoTargets, 'clod')).toThrow('is not declared');
    expect(() => requireTarget(twoTargets, 'clod')).toThrow('local');
    expect(() => requireTarget(twoTargets, 'clod')).toThrow('cloud');
  });

  test('the refusal names the workspace, because that is what holds the registry', () => {
    expect(notInRegistry('clod', twoTargets, '/ws').message).toContain('/ws');
  });

  test('deploy may name a target that does not exist yet', () => {
    // The one command whose job is to create the target it was given. Every
    // other command naming an unknown one has made a typo.
    expect(requireTarget(localOnly, 'cloud', { allowUndeclared: true })).toBe('cloud');
  });

  test('two deployable targets are both nameable, and neither is a default', () => {
    expect(requireTarget(twoDeployable, 'staging')).toBe('staging');
    expect(() => requireTarget(twoDeployable, undefined)).toThrow('--target is required');
  });
});
