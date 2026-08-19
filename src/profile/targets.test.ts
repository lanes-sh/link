import { describe, expect, test } from 'bun:test';
import { parseConfig } from './load.ts';
import { resolveDeployTarget, resolveTarget } from './targets.ts';

/**
 * Which target a command acts on, and where that answer came from.
 *
 * Every case passes an explicit `env`. A developer who exports
 * `LANES_LINK_TARGET` in their own shell would otherwise change what these
 * assert, which is the failure mode the variable itself exists to make visible
 * and the last place it should be able to hide.
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

  test('defaults to instance.default_target', () => {
    expect(resolveTarget(twoTargets, undefined, { env: {} })).toEqual({
      target: 'local',
      source: 'config-default',
    });
  });

  test('--target overrides it', () => {
    expect(resolveTarget(twoTargets, 'cloud', { env: {} })).toEqual({
      target: 'cloud',
      source: 'flag',
    });
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
    expect(() => resolveTarget(twoTargets, 'staging', { env: {} })).toThrow(
      /Target "staging" is not declared.*local, cloud/s,
    );
  });

  test('a deploy works out which target it meant', () => {
    // `--target cloud` was required on every deploy because an absent flag fell
    // back to `instance.default_target` — `local`, a target that is by
    // definition not deployed. The one command whose subject is never ambiguous
    // was the one that made you say it.
    expect(resolveDeployTarget(twoTargets)).toEqual({ target: 'cloud', source: 'deployable' });
  });

  test('--target still wins, which is how you deploy the second one', () => {
    expect(resolveDeployTarget(twoTargets, 'staging')).toEqual({
      target: 'staging',
      source: 'flag',
    });
  });

  test('with nothing deployable it proposes the conventional name', () => {
    // The first run: no target has a deployment yet, and `cloud` is what every
    // example names. The survey then creates it.
    expect(resolveDeployTarget(localOnly)).toEqual({ target: 'cloud', source: 'deployable' });
  });

  test('two deployable targets is a real question, so it asks', () => {
    // Rolling a revision to whichever came first in a YAML mapping is the one
    // answer that cannot be right on purpose.
    expect(() => resolveDeployTarget(twoDeployable)).toThrow(
      /2 deployable targets \(cloud, staging\).*--target/s,
    );
  });

  test('unless the caller is going to create it', () => {
    // `deploy` on a first run: the target it names is the one it is about to
    // write. Refusing there made a command whose whole job is bootstrapping
    // demand that the thing already exist. Nothing else passes this — a typo
    // in `--target` should still hit the list above rather than quietly
    // deploying a target nobody declared.
    expect(resolveTarget(twoTargets, 'staging', { allowUndeclared: true, env: {} })).toEqual({
      target: 'staging',
      source: 'flag',
    });
  });

  test('LANES_LINK_TARGET sits between the flag and the config default', () => {
    const env = { LANES_LINK_TARGET: 'cloud' };

    expect(resolveTarget(twoTargets, undefined, { env })).toEqual({
      target: 'cloud',
      source: 'environment',
    });
    expect(resolveTarget(twoTargets, 'local', { env })).toEqual({
      target: 'local',
      source: 'flag',
    });
  });

  test('an empty LANES_LINK_TARGET is not an answer', () => {
    // `export LANES_LINK_TARGET=` leaves the name set to the empty string, which
    // is a target nobody declared. Reading it as "unset" is the only reading
    // that does not fail every command in the shell with a puzzle.
    expect(resolveTarget(twoTargets, undefined, { env: { LANES_LINK_TARGET: '' } })).toEqual({
      target: 'local',
      source: 'config-default',
    });
  });

  test('an undeclared target from the environment says so, and how to undo it', () => {
    // Without this, an exported typo fails every command in the shell with a
    // message that reads as a problem with the config file — and the file is
    // fine. The variable is the only thing that knows where the name came from.
    expect(() =>
      resolveTarget(twoTargets, undefined, { env: { LANES_LINK_TARGET: 'clod' } }),
    ).toThrow(/LANES_LINK_TARGET=clod is set in this shell/);
  });

  test('deploy ignores LANES_LINK_TARGET, deliberately', () => {
    // `deploy` is the one caller that may name an undeclared target, so an
    // exported typo would not be refused here — it would be surveyed, written
    // into the profile, and rolled out as a new service. An environment
    // variable must not be able to name a Cloud Run service into existence.
    const previous = process.env['LANES_LINK_TARGET'];
    process.env['LANES_LINK_TARGET'] = 'local';
    try {
      expect(resolveDeployTarget(twoTargets)).toEqual({ target: 'cloud', source: 'deployable' });
    } finally {
      if (previous === undefined) delete process.env['LANES_LINK_TARGET'];
      else process.env['LANES_LINK_TARGET'] = previous;
    }
  });
});
