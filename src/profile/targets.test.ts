import { describe, expect, test } from 'bun:test';
import { parseConfig } from './load.ts';
import { noTargetInWorkspace, noTargetNamed, requireTarget } from './targets.ts';

/**
 * Which target a command acts on.
 *
 * `--target`, or it does not run. What used to be tested here was a precedence
 * chain — flag, then `LANES_LINK_TARGET`, then `instance.default_target` — and
 * those cases are gone rather than inverted, because the thing they described
 * no longer exists (ADR-037). What is left is worth more: that a command
 * naming nothing is refused with the list, and that the refusal names the two
 * things an operator is most likely to still be looking at.
 */

describe('target resolution', () => {
  const twoTargets = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage: { adapter: filesystem, path: ./data/files }
  cloud:
    credentials: { adapter: gcp-secret-manager }
    storage: { adapter: s3, bucket: lanes-link-demo }
    cloudrun: { project: p, region: r, service: s }
`).config;

  const localOnly = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage: { adapter: filesystem, path: ./data/files }
`).config;

  const twoDeployable = parseConfig(`
contract: 1
instance:
  profile: personal
  default_target: cloud
targets:
  cloud:
    credentials: { adapter: gcp-secret-manager, project: p }
    storage: { adapter: gcs, bucket: b }
    deploy: { platform: cloudrun, project: p, region: r, service: s }
  staging:
    credentials: { adapter: gcp-secret-manager, project: p2 }
    storage: { adapter: gcs, bucket: b2 }
    deploy: { platform: cloudrun, project: p2, region: r, service: s2 }
`).config;

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

  test('the refusal names an exported variable that no longer resolves', () => {
    // The single most confusing state during the change: a shell still
    // configured for the old world, where nothing on screen says the variable
    // stopped counting. Self-limiting — it disappears when the variable does.
    const message = noTargetNamed(twoTargets, 'personal', {
      LANES_LINK_TARGET: 'cloud',
    }).message;

    expect(message).toContain('LANES_LINK_TARGET=cloud');
    expect(message).toContain('no longer read');
  });

  test('and the inert key still sitting in the profile', () => {
    // Which is why the schema keeps parsing it. A key stripped by the schema is
    // a key nothing can report, and an operator looking at
    // `default_target: local` has every reason to think it still selects one.
    expect(noTargetNamed(twoTargets, 'personal', {}).message).toContain(
      'instance.default_target: local',
    );
  });

  test('says nothing about a variable that is not set', () => {
    expect(noTargetNamed(twoTargets, 'personal', {}).message).not.toContain('LANES_LINK_TARGET');
  });

  test('one config yields a different adapter set per target', () => {
    // Connections, providers, and policy are declared once and apply to every
    // target; only the adapters differ.
    expect(twoTargets.targets['local']?.storage.adapter).toBe('filesystem');
    expect(twoTargets.targets['cloud']?.storage.adapter).toBe('s3');
    expect(twoTargets.targets['local']?.credentials.adapter).toBe('file');
    expect(twoTargets.targets['cloud']?.credentials.adapter).toBe('gcp-secret-manager');
  });

  test('an undeclared target fails and lists what exists', () => {
    expect(() => requireTarget(twoTargets, 'clod')).toThrow('is not declared');
    expect(() => requireTarget(twoTargets, 'clod')).toThrow('local, cloud');
  });

  test('unless the caller is going to create it — which is deploy, on a first run', () => {
    expect(requireTarget(localOnly, 'cloud', { allowUndeclared: true })).toBe('cloud');
  });

  test('a profile with two deployable targets is no longer a question', () => {
    // `resolveDeployTarget` guessed, refused, or invented a name depending on
    // how many targets declared a deploy block. Naming one answers it
    // structurally, on the one command that creates cloud resources.
    expect(requireTarget(twoDeployable, 'staging')).toBe('staging');
    expect(() => requireTarget(twoDeployable, undefined)).toThrow('--target is required');
  });
});

/**
 * The refusal for a target-scoped command, which describes the workspace.
 *
 * `noTargetNamed` lists one profile's targets with their adapters, because a
 * command acting on one profile wants to know which of *its* places to run in.
 * A target-scoped command is asking something else — which endpoint — and the
 * useful column there is who declares it (ADR-043).
 */
describe('refusing a target-scoped command that named no target', () => {
  const byName = (entries: Record<string, string[]>): ReadonlyMap<string, readonly string[]> =>
    new Map(Object.entries(entries));

  test('lists the targets the workspace declares', () => {
    const message = noTargetInWorkspace(
      byName({ local: ['personal', 'work'], cloud: ['personal'] }),
      '/ws',
      {},
    ).message;

    expect(message).toContain('--target is required');
    expect(message).toContain('Targets in /ws');
    expect(message).toContain('e.g. lanes link status --target local');
  });

  test('names the profiles only where they are not all of them', () => {
    // The list is there to show a gap. Printing it when there is none turns the
    // signal into noise on every well-configured workspace.
    const message = noTargetInWorkspace(
      byName({ local: ['personal', 'work'], cloud: ['personal'] }),
      '/ws',
      {},
    ).message;

    expect(message).toContain('local    every profile');
    expect(message).toContain('cloud    personal');
  });

  test('says so plainly when no profile declares anything', () => {
    const message = noTargetInWorkspace(byName({}), '/ws', {}).message;

    expect(message).toContain('no profile in /ws declares one');
    expect(message).toContain('profile add <name> --target local');
  });

  test('names a stale LANES_LINK_TARGET, which is no longer read', () => {
    const message = noTargetInWorkspace(byName({ local: ['personal'] }), '/ws', {
      LANES_LINK_TARGET: 'cloud',
    }).message;

    expect(message).toContain('LANES_LINK_TARGET=cloud is set in this shell');
  });
});
