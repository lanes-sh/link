import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, TargetConfig } from '#profile';
import {
  deepWithoutUndefined,
  parseAccess,
  resolveTarget,
  vaultEnv,
  willSurvey,
} from './bootstrap.ts';

/**
 * The config a first deploy writes for itself.
 *
 * The survey is interactive and is not exercised here; what is, is everything
 * downstream of an answer — because those are the parts that turn a surveyed
 * target into YAML and into argv, and both fail quietly when they are wrong.
 */

const target = (vault?: TargetConfig['vault']): TargetConfig =>
  ({
    credentials: { adapter: 'gcp-secret-manager', project: 'personal-lanes' },
    storage: { adapter: 'gcs', bucket: 'lanes-link-demo-data' },
    ...(vault ? { vault } : {}),
  }) as TargetConfig;

describe('the vault key a revision reads from its own store', () => {
  test('a sealed-document vault asks for the key by reference', () => {
    // Named here rather than in the driver because *whether* there is a key is
    // a property of the target's adapters; how a platform mounts one is not.
    expect(vaultEnv(target({ adapter: 'secret' }))).toEqual({
      LANES_LINK_VAULT_KEY: 'vault/key',
    });
    expect(vaultEnv(target({ adapter: 'blob' }))).toEqual({
      LANES_LINK_VAULT_KEY: 'vault/key',
    });
  });

  test('a file vault, or none, asks for nothing', () => {
    // A `file` vault is a local run, where the variable is the operator's own
    // business — and mounting a secret for it would be a Cloud Run mount for a
    // target that is not deployed.
    expect(vaultEnv(target({ adapter: 'file' }))).toBeUndefined();
    expect(vaultEnv(target())).toBeUndefined();
  });
});

describe('writing a surveyed target into YAML', () => {
  test('an absent value is dropped rather than written as null', () => {
    // `setIn` writes an explicit null for undefined, and a null fails schema
    // validation on the very next command — so a first deploy would leave the
    // profile in a state that no longer loads.
    expect(
      deepWithoutUndefined({
        platform: 'cloudrun',
        project: 'personal-lanes',
        service_account: undefined,
      }),
    ).toEqual({ platform: 'cloudrun', project: 'personal-lanes' });
  });

  test('nested blocks are cleaned too, because a target is blocks of blocks', () => {
    const surveyed: Record<string, unknown> = {
      credentials: { adapter: 'gcp-secret-manager', project: 'p' },
      storage: { adapter: 'gcs', bucket: 'b', prefix: undefined },
      deploy: { platform: 'cloudrun', region: 'europe-west1', service_account: undefined },
    };

    expect(deepWithoutUndefined(surveyed)).toEqual({
      credentials: { adapter: 'gcp-secret-manager', project: 'p' },
      storage: { adapter: 'gcs', bucket: 'b' },
      deploy: { platform: 'cloudrun', region: 'europe-west1' },
    });
  });
});

describe('a target the workspace already answers', () => {
  const complete = { auth: {} } as unknown as Config;

  /**
   * A workspace whose registry declares `cloud` completely.
   *
   * On disk rather than as an object, because `resolveTarget` reads the registry
   * itself now — the answers it is looking for are the workspace's, not the
   * profile's (ADR-052), and a hand-built `config.targets` is exactly the shape
   * that stopped existing.
   */
  const roots: string[] = [];
  async function declared(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-bootstrap-'));
    roots.push(root);
    await writeFile(
      join(root, 'lanes-link.yaml'),
      'contract: 3\nworkspaces:\n  cloud:\n' +
        '    credentials: { adapter: gcp-secret-manager, project: p }\n' +
        '    storage: { adapter: gcs, bucket: b }\n' +
        '    deploy:\n      platform: cloudrun\n      project: p\n' +
        '      region: europe-west1\n      service: lanes-link-personal-mcp\n      access: iam\n',
    );
    return root;
  }

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const resolve = async (flags: Parameters<typeof resolveTarget>[0]['flags']) => {
    const root = await declared();
    return resolveTarget({
      config: complete,
      profilePath: `${root}/profiles/personal.yaml`,
      workspaceRoot: root,
      profile: 'personal',
      target: 'cloud',
      flags,
    });
  };

  test('is used as-is when nobody is there to answer', async () => {
    // A test run has no terminal, which is the same situation as a scripted
    // deploy: the stored answers are the answers, and reaching a prompt would
    // throw rather than hang.
    const declared = await resolve({});

    expect(declared.deploy?.service).toBe('lanes-link-personal-mcp');
    expect(declared.deploy?.project).toBe('p');
  });

  test('a flag overrides for one run without editing the file', async () => {
    expect((await resolve({ access: 'public' })).deploy?.access).toBe('public');
    expect((await resolve({})).deploy?.access).toBe('iam');
  });
});

describe('whether a run asks its setup questions', () => {
  const complete = { deploy: { platform: 'cloudrun' } } as unknown as TargetConfig;

  test('asks every time, so the values are visible rather than buried in YAML', () => {
    // Not asked-once. Every prompt defaults to what the config says, so pressing
    // return through the survey changes nothing and re-generates nothing — the
    // random project and bucket names are stored values by then, not fresh draws.
    expect(willSurvey(complete, {}, true)).toBe(true);
  });

  test('takes the stored answers when there is nobody to ask', () => {
    // Otherwise every scripted deploy dies at the first prompt.
    expect(willSurvey(complete, {}, false)).toBe(false);
    expect(willSurvey(complete, { nonInteractive: true }, true)).toBe(false);
  });

  test('asks regardless when the config has no answer to take', () => {
    // A first run, where refusing is the only alternative. It refuses at the
    // prompt it could not ask, which names what is missing.
    expect(willSurvey(undefined, { nonInteractive: true }, false)).toBe(true);
    expect(willSurvey({} as TargetConfig, {}, false)).toBe(true);
  });
});

describe('--access', () => {
  test('takes the two values the platform has doors for', () => {
    expect(parseAccess('iam')).toBe('iam');
    expect(parseAccess('public')).toBe('public');
    expect(parseAccess(undefined)).toBeUndefined();
  });

  test('anything else is refused rather than defaulted', () => {
    // Defaulting a misspelling to `iam` deploys a service every MCP client sees
    // as 403, and to `public` opens one. Neither is a guess worth making.
    expect(() => parseAccess('open')).toThrow(/--access must be "iam" or "public"/);
  });
});
