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

  test('an undeclared default_target fails and lists what is available', () => {
    rejects((y) => y.replace('default_target: local', 'default_target: cloud'), /not a declared target.*local/s);
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
