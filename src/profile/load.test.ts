import { describe, expect, test } from 'bun:test';
import { ConfigError, parseConfig, validateConfig } from './load.ts';

/** A minimal valid config; each test overrides the part it is about. */
const VALID = `
contract: 1
instance:
  profile: personal
  default_target: local
targets:
  local:
    credentials: { adapter: file, path: ./data/personal.credentials.enc }
    storage: { adapter: filesystem, path: ./data/personal/files }
connections:
  - id: a
    provider: example
    account: Scratch
policy:
  allow:
    - "example.*"
`;

describe('a valid config', () => {
  test('loads and applies defaults', () => {
    const { config, connectionKeys } = parseConfig(VALID);

    expect(config.instance.profile).toBe('personal');
    expect(config.instance.port).toBe(7337);
    expect(config.instance.host).toBe('127.0.0.1');
    expect(config.auth.token_ref).toBe('profile/token');
    expect(config.limits.requests_per_minute).toBe(120);
    expect(connectionKeys).toEqual(['example.a']);
  });

  test('an absent policy block grants nothing', () => {
    const { config } = parseConfig(VALID.replace(/policy:[\s\S]*$/, ''));
    expect(config.policy.allow).toEqual([]);
    expect(config.policy.deny).toEqual([]);
  });
});

describe('contract major fails closed', () => {
  test('rejects a newer major outright', () => {
    expect(() => parseConfig(VALID.replace('contract: 1', 'contract: 2'))).toThrow(
      /contract 2 is newer than.*Upgrade lanes-link/s,
    );
  });

  test('rejects an older major outright', () => {
    expect(() => parseConfig(VALID.replace('contract: 1', 'contract: 0'))).toThrow(/older than/);
  });

  test('rejects a missing or non-integer contract', () => {
    expect(() => parseConfig(VALID.replace('contract: 1\n', ''))).toThrow(/"contract" is required/);
    expect(() => parseConfig(VALID.replace('contract: 1', 'contract: "1"'))).toThrow(
      /must be an integer/,
    );
  });

  test('the contract check runs before anything else', () => {
    // A config that is wrong in several ways must report the contract, because
    // under an unknown major we cannot claim to know what the rest means.
    const broken = VALID.replace('contract: 1', 'contract: 99').replace(
      'default_target: local',
      'default_target: nope',
    );
    expect(() => parseConfig(broken)).toThrow(/contract 99/);
  });
});

describe('credential values are rejected', () => {
  const withValue = (yaml: string) => () => parseConfig(`${VALID}\n${yaml}`);

  test('rejects a Google refresh token pasted into a connection', () => {
    expect(
      withValue(`
oauth_apps:
  google:
    client_id_ref: google/client_id
    client_secret_ref: ya29.a0AfH6SMBx7QK2mZ9vLpQrStUvWxYz
`),
    ).toThrow(/ya29\.|credential/i);
  });

  test('rejects an inline private key block', () => {
    expect(
      withValue(`
extra:
  key_material: |
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM
    -----END RSA PRIVATE KEY-----
`),
    ).toThrow(/private key/i);
  });

  test.each([
    ['sk-proj-abc123XYZdefGHI456jklMNO', 'an OpenAI-style key'],
    ['xoxb-2401234567-abcDEF123456', 'a Slack bot token'],
    ['ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'a GitHub token'],
    ['AKIAIOSFODNN7EXAMPLE', 'an AWS key id'],
    ['llk_dGhpc0lzQVRlc3RUb2tlbjEyMzQ1Njc4OTA', 'a Lanes Link token'],
  ])('rejects %s', (value) => {
    expect(withValue(`extra:\n  anything: "${value}"`)).toThrow(ConfigError);
  });

  test('rejects a credential-named key holding a literal, however innocuous', () => {
    // The value is short and low-entropy; the KEY is what makes it wrong.
    expect(withValue(`extra:\n  client_secret: hunter2`)).toThrow(/must hold a reference/);
    expect(withValue(`extra:\n  api_password: letmein`)).toThrow(/must hold a reference/);
    expect(withValue(`extra:\n  signing_key: abc`)).toThrow(/must hold a reference/);
  });

  test('the error names the exact path', () => {
    let message = '';
    try {
      parseConfig(`${VALID}\nextra:\n  nested:\n    client_secret: hunter2`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('extra.nested.client_secret');
  });

  test('the error names the path inside an array', () => {
    let message = '';
    try {
      parseConfig(`${VALID}\nextra:\n  - name: one\n  - client_secret: hunter2`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('extra[1].client_secret');
  });

  test('a detected secret is reported before schema errors', () => {
    // Zod strips unknown keys, so a credential under a misspelled key would
    // otherwise pass validation completely invisibly.
    const broken = `${VALID.replace('profile: personal', 'profile: "Not Valid"')}\nextra:\n  client_secret: hunter2`;
    expect(() => parseConfig(broken)).toThrow(/must hold a reference/);
  });
});

describe('legitimate values are not mistaken for credentials', () => {
  const accepts = (yaml: string) => expect(() => parseConfig(`${VALID}\n${yaml}`)).not.toThrow();

  test('accepts _ref keys, which are exactly what config should hold', () => {
    accepts(`
oauth_apps:
  google:
    client_id_ref: google/client_id
    client_secret_ref: google/client_secret
`);
  });

  test('accepts filesystem paths', () => {
    accepts('extra:\n  path: ./data/personal.credentials.enc');
    accepts('extra:\n  path: /Users/someone/very/long/path/to/a/directory/of/files');
  });

  test('accepts human display names and addresses', () => {
    accepts('extra:\n  display_name: "Work — Google Workspace (primary)"');
    accepts('extra:\n  address: someone.with.a.long.name@example.com');
  });

  test('accepts URLs', () => {
    accepts('extra:\n  url: https://accounts.google.com/o/oauth2/v2/auth?response_type=code');
  });
});

describe('referential integrity', () => {
  const rejects = (mutate: (yaml: string) => string, pattern: RegExp) =>
    expect(() => parseConfig(mutate(VALID))).toThrow(pattern);

  test('an allow rule naming a provider with no connection fails rather than granting nothing', () => {
    rejects((y) => y.replace('- "example.*"', '- "gmail.search"'), /has no connection/);
  });

  test('a deny rule may name a provider you have not connected yet', () => {
    // Denying something ahead of connecting it is a reasonable thing to write,
    // and refusing it would punish the cautious ordering.
    expect(() =>
      parseConfig(`${VALID}  deny:\n    - "gmail.send_message"\n`),
    ).not.toThrow();
  });

  test('a bare * needs no provider to exist', () => {
    expect(() => parseConfig(VALID.replace('- "example.*"', '- "*"'))).not.toThrow();
  });

  test('duplicate connection ids within a provider fail', () => {
    const yaml = VALID.replace(
      '  - id: a\n    provider: example\n    account: Scratch',
      '  - id: a\n    provider: example\n    account: Scratch\n  - id: a\n    provider: example\n    account: Dupe',
    );
    expect(() => parseConfig(yaml)).toThrow(/duplicate connection "example\.a"/);
  });

  test('the same connection id under different providers is fine', () => {
    const yaml = VALID.replace(
      '  - id: a\n    provider: example\n    account: Scratch',
      '  - id: main\n    provider: example\n    account: Scratch\n  - id: main\n    provider: gmail\n    account: Mail',
    );
    expect(() => parseConfig(yaml)).not.toThrow();
  });

  test('two accounts of the same provider coexist', () => {
    // The shape that replaced main/main2: distinct ids, distinct accounts, one
    // rule covering both.
    const yaml = VALID.replace(
      '  - id: a\n    provider: example\n    account: Scratch',
      '  - id: work\n    provider: example\n    account: me@work.example\n  - id: home\n    provider: example\n    account: me@home.example',
    );
    const { config } = parseConfig(yaml);
    expect(config.connections.map((c) => c.account)).toEqual(['me@work.example', 'me@home.example']);
    expect(config.policy.allow).toEqual([{ capability: 'example.*' }]);
  });

  test('a default_target naming nothing is harmless, because nothing reads it', () => {
    // It used to be a validation failure. Nothing consults the key now
    // (ADR-037), so failing `check` on a stale value would teach that it still
    // matters — and every profile written before the change carries one.
    expect(() =>
      parseConfig(VALID.replace('default_target: local', 'default_target: clod'), 'x.yaml'),
    ).not.toThrow();
  });

  test('and so is leaving it out entirely', () => {
    expect(() => parseConfig(VALID.replace('  default_target: local\n', ''), 'x.yaml')).not.toThrow();
  });
});

/**
 * The one id that moved out from under a profile — ADR-051.
 *
 * A refusal rather than a warning, because the failure it replaces is silent:
 * the row resolves to the built-in, reconcile calls it active, and the operator
 * loses their Google Tasks tools with nothing saying why.
 */
describe('a provider whose id has been renamed', () => {
  const withTasks = (id: string, account: string) =>
    VALID.replace(
      '  - id: a\n    provider: example\n    account: Scratch',
      `  - id: a\n    provider: example\n    account: Scratch\n  - id: ${id}\n    provider: tasks\n    account: ${account}`,
    );

  test('a tasks row wearing any other label is refused, and names google_tasks', () => {
    expect(() => parseConfig(withTasks('ada', 'ada.lovelace@example.com'))).toThrow(
      /set provider to google_tasks/,
    );
  });

  test('a label that is not an address is caught too — the case a heuristic missed', () => {
    // The first version of this check keyed on an `@`, reasoning that `connect`
    // recorded the address that was typed. What `connect` asks an accountless
    // provider for is a *label*, and the real profile this was written for holds
    // `account: personal` — so the heuristic passed it and would have rebound
    // Google Tasks to the built-in in silence.
    expect(() => parseConfig(withTasks('personal', 'personal'))).toThrow(
      /set provider to google_tasks/,
    );
  });

  test("the built-in's own row is not mistaken for it", () => {
    expect(() => parseConfig(withTasks('main', 'Tasks'))).not.toThrow();
  });

  test('a second task list is allowed, as long as it is labelled like the first', () => {
    // Keying on `id !== "main"` would have refused this forever to catch a
    // one-release migration. Every accountless provider labels its rows the same
    // way — every memory connection is `Memory` — so this is the existing shape.
    expect(() => parseConfig(withTasks('work', 'Tasks'))).not.toThrow();
  });

  test('the refusal offers the other fix too, for a hand-edited built-in row', () => {
    expect(() => parseConfig(withTasks('work', 'Work'))).toThrow(/set account to Tasks/);
  });

  test('the refusal names the command that applies it, with the selection it needs', () => {
    // The refusal is at *load*, so it takes every command down with it and the
    // operator's only way back was to hand-edit YAML. Both flags come off the
    // document rather than off whatever command tripped over it, because nothing
    // has resolved anything at this point.
    expect(() => parseConfig(withTasks('personal', 'personal'))).toThrow(
      /lanes link doctor --fix --profile personal --target local/,
    );
  });

  test('a profile with several targets gets a placeholder rather than a guess', () => {
    const twoTargets = withTasks('personal', 'personal').replace(
      '    storage: { adapter: filesystem, path: ./data/personal/files }',
      '    storage: { adapter: filesystem, path: ./data/personal/files }\n  cloud:\n    credentials: { adapter: gcp-secret-manager, project: p }\n    storage: { adapter: gcs, bucket: b }',
    );
    expect(() => parseConfig(twoTargets)).toThrow(/--target <local\|cloud>/);
  });

  test('google_tasks itself is fine, which is the whole point', () => {
    const yaml = VALID.replace(
      '  - id: a\n    provider: example\n    account: Scratch',
      '  - id: a\n    provider: example\n    account: Scratch\n  - id: ada\n    provider: google_tasks\n    account: ada.lovelace@example.com',
    );
    expect(() => parseConfig(yaml)).not.toThrow();
  });
});

describe('where a target deploys', () => {
  /** `VALID` with a second target carrying whatever deployment block is under test. */
  const withTarget = (block: string) =>
    VALID.replace(
      '    storage: { adapter: filesystem, path: ./data/personal/files }',
      '    storage: { adapter: filesystem, path: ./data/personal/files }\n' +
        '  cloud:\n' +
        '    credentials: { adapter: gcp-secret-manager, project: my-project }\n' +
        '    storage: { adapter: s3, bucket: link-blobs }\n' +
        block,
    );

  test('a deploy block names its platform and defaults to the closed door', () => {
    const { config } = parseConfig(
      withTarget(
        '    deploy:\n      platform: cloudrun\n      project: my-project\n' +
          '      region: europe-west1\n      service: lanes-link\n',
      ),
    );

    expect(config.targets['cloud']?.deploy).toEqual({
      platform: 'cloudrun',
      project: 'my-project',
      region: 'europe-west1',
      service: 'lanes-link',
      access: 'iam',
      // Scaling to zero is the default, and stays the default: a cold start is
      // under three seconds and the platform queues the request behind it.
      min_instances: 0,
    });
  });

  test('the pre-deploy "cloudrun" block still loads, as a deploy block', () => {
    // One shape reaches the rest of the codebase. A config written before the
    // platform discriminator existed keeps working without an edit.
    const { config } = parseConfig(
      withTarget(
        '    cloudrun:\n      project: my-project\n      region: europe-west1\n      service: lanes-link\n',
      ),
    );

    expect(config.targets['cloud']?.deploy).toEqual({
      platform: 'cloudrun',
      project: 'my-project',
      region: 'europe-west1',
      service: 'lanes-link',
      access: 'iam',
      min_instances: 0,
    });
  });

  test('declaring both is refused rather than resolved by precedence', () => {
    // A second place to say where this deploys could only ever disagree with
    // the first, and silently preferring one rolls a revision into the project
    // the operator was not reading.
    expect(() =>
      parseConfig(
        withTarget(
          '    deploy:\n      platform: cloudrun\n      project: a\n      region: r\n      service: s\n' +
            '    cloudrun:\n      project: b\n      region: r\n      service: s\n',
        ),
      ),
    ).toThrow(/both "deploy" and "cloudrun" are declared/);
  });

  test('an unknown platform is refused at load, not at deploy', () => {
    expect(() =>
      parseConfig(
        withTarget(
          '    deploy:\n      platform: app-runner\n      region: eu-west-1\n      service: lanes-link\n',
        ),
      ),
    ).toThrow(/platform/);
  });

  test('an empty service name fails here rather than minutes into a build', () => {
    expect(() =>
      parseConfig(
        withTarget(
          '    deploy:\n      platform: cloudrun\n      project: p\n      region: r\n      service: ""\n',
        ),
      ),
    ).toThrow(/targets\.cloud\.deploy\.service/);
  });

  test('a missing project is not refused here — the driver that needs it says so', () => {
    // `project` means something to one platform and nothing to the next, on the
    // same reasoning as `credentials.project`.
    expect(() =>
      parseConfig(
        withTarget(
          '    deploy:\n      platform: cloudrun\n      region: europe-west1\n      service: lanes-link\n',
        ),
      ),
    ).not.toThrow();
  });
});

describe('policy grammar', () => {
  const withCapability = (capability: string) =>
    VALID.replace('- "example.*"', `- "${capability}"`);

  test('accepts a bare *, a provider wildcard, and an exact capability', () => {
    for (const good of [
      '*',
      'example.*',
      'example.echo',
      'example.get-note',
      // Dotted, because an OpenAPI operationId is.
      'example.users.drafts.send',
      'example.users.*',
    ]) {
      expect(() => parseConfig(withCapability(good))).not.toThrow();
    }
  });

  test('rejects every other wildcard form, so there is no expression language', () => {
    for (const bad of ['example.*.read', 'exa*.echo', 'example.ec*', '**', '*.echo', 'example..echo']) {
      expect(() => parseConfig(withCapability(bad))).toThrow();
    }
  });

  test('the object form carries an expiry and parses to the same rule', () => {
    const { config } = parseConfig(
      VALID.replace('- "example.*"', '- { capability: "example.*", expires_at: "2027-01-01T00:00:00Z" }'),
    );
    expect(config.policy.allow[0]).toEqual({
      capability: 'example.*',
      expires_at: '2027-01-01T00:00:00Z',
    });
  });
});

describe('malformed input', () => {
  test('rejects a non-mapping top level', () => {
    expect(() => validateConfig(['a', 'b'])).toThrow(/expected a YAML mapping/);
    expect(() => validateConfig('just a string')).toThrow(/expected a YAML mapping/);
    expect(() => validateConfig(null)).toThrow(/expected a YAML mapping/);
  });

  test('reports unparseable YAML as such', () => {
    expect(() => parseConfig('contract: 1\n  bad: [indent')).toThrow(/could not parse YAML/);
  });

  test('rejects an out-of-range port', () => {
    expect(() => parseConfig(VALID.replace('profile: personal', 'profile: personal\n  port: 99999'))).toThrow(
      /port/,
    );
  });

  test('names the offending field on a schema error', () => {
    let message = '';
    try {
      parseConfig(VALID.replace('profile: personal', 'profile: "Has Spaces"'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('instance.profile');
  });
});

describe('the knowledge block', () => {
  /** Insert a `knowledge:` block under the `local` target. */
  const withKnowledge = (block: string): string =>
    VALID.replace(
      '    storage: { adapter: filesystem, path: ./data/personal/files }',
      `    storage: { adapter: filesystem, path: ./data/personal/files }\n${block}`,
    );

  test('is absent by default, which is what every existing profile relies on', () => {
    const { config } = parseConfig(VALID);
    expect(config.targets['local']?.knowledge).toBeUndefined();
  });

  test('takes a repository and defaults the ref', () => {
    const { config } = parseConfig(
      withKnowledge('    knowledge: { adapter: github, repo: my-org/my-notes }'),
    );

    expect(config.targets['local']?.knowledge).toEqual({
      adapter: 'github',
      repo: 'my-org/my-notes',
      token_ref: 'knowledge/token',
    });
  });

  test('keeps a branch and a path when given', () => {
    const { config } = parseConfig(
      withKnowledge(
        '    knowledge: { adapter: github, repo: my-org/my-notes, branch: trunk, path: context }',
      ),
    );

    expect(config.targets['local']?.knowledge?.branch).toBe('trunk');
    expect(config.targets['local']?.knowledge?.path).toBe('context');
  });

  test('normalises a path so one prefix has one spelling', () => {
    const { config } = parseConfig(
      withKnowledge('    knowledge: { adapter: github, repo: my-org/my-notes, path: "/context/" }'),
    );

    expect(config.targets['local']?.knowledge?.path).toBe('context');
  });

  test('refuses a URL where "owner/name" belongs', () => {
    expect(() =>
      parseConfig(
        withKnowledge(
          '    knowledge: { adapter: github, repo: "https://github.com/my-org/my-notes" }',
        ),
      ),
    ).toThrow(/owner\/name/);
  });

  test('refuses a path that walks out of the repository', () => {
    expect(() =>
      parseConfig(
        withKnowledge('    knowledge: { adapter: github, repo: my-org/my-notes, path: "../.." }'),
      ),
    ).toThrow(/\.\./);
  });

  test('refuses a token written inline instead of referenced', () => {
    // `secret-detection.ts` already knows the fine-grained prefix; this asserts
    // it covers the one field somebody would most plausibly paste one into.
    expect(() =>
      validateConfig(
        withKnowledge(
          '    knowledge: { adapter: github, repo: my-org/my-notes, token_ref: github_pat_11ABCDE0Y0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmno }',
        ),
      ),
    ).toThrow();
  });

  test('cannot name the credential store or the vault', () => {
    // Structural, not defaulted off: there is no field to set. Both keys are
    // stripped by zod rather than honoured, so the block still parses and still
    // means only what it can mean.
    const { config } = parseConfig(
      withKnowledge(
        '    knowledge: { adapter: github, repo: my-org/my-notes, credentials: file, vault: blob }',
      ),
    );

    expect(config.targets['local']?.knowledge).not.toHaveProperty('credentials');
    expect(config.targets['local']?.knowledge).not.toHaveProperty('vault');
  });
});
