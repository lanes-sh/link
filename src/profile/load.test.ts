import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { ConfigError, parseConfig, validateConfig } from './load.ts';
import { legacyTargetSchema } from './legacy.ts';
import { DEPLOY_DEFAULTS, workspaceSchema } from './schema.ts';
import { assertNoRenamedProviders } from './connections.ts';

/** A minimal valid config; each test overrides the part it is about. */
const VALID = `
contract: 3
instance:
  profile: personal
grants:
  - connection: example.a
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

  test('an absent grants block grants nothing', () => {
    const { config } = parseConfig(VALID.replace(/grants:[\s\S]*$/, ''));
    expect(config.grants).toEqual([]);
    expect(config.members).toEqual([]);
  });
});

describe('contract major fails closed', () => {
  test('rejects a newer major outright', () => {
    expect(() => parseConfig(VALID.replace('contract: 3', 'contract: 4'))).toThrow(
      /contract 4 is newer than.*Upgrade lanes-link/s,
    );
  });

  test('rejects an older major outright', () => {
    expect(() => parseConfig(VALID.replace('contract: 3', 'contract: 0'))).toThrow(/older than/);
  });

  // Contract 1 is the shape this release replaced, and it is refused here rather
  // than read: `profile/legacy.ts` understands it and only the migration uses
  // that, so a profile still carrying `targets:` fails at the boundary with a
  // sentence naming the migration (ADR-052).
  test('rejects contract 2, which the migration handles instead', () => {
    expect(() => parseConfig(VALID.replace('contract: 3', 'contract: 2'))).toThrow(
      /contract 2 is older than/,
    );
  });

  test('rejects a missing or non-integer contract', () => {
    expect(() => parseConfig(VALID.replace('contract: 3\n', ''))).toThrow(/"contract" is required/);
    expect(() => parseConfig(VALID.replace('contract: 3', 'contract: "2"'))).toThrow(
      /must be an integer/,
    );
  });

  test('the contract check runs before anything else', () => {
    // A config that is wrong in several ways must report the contract, because
    // under an unknown major we cannot claim to know what the rest means.
    const broken = VALID.replace('contract: 3', 'contract: 99').replace(
      'profile: personal',
      'profile: "not an identifier"',
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

  // Nothing here checks whether a granted connection *exists*. That question
  // needs `connections.yaml`, which a single profile cannot see, so
  // `assertGrantsResolve` answers it once both have been read (ADR-057). What
  // is checkable from one profile alone is checked here, and only that.

  test('a rule naming another provider is refused rather than matching nothing', () => {
    // The sharpest of these. `allowedConnections` filters candidates to the
    // capability's own provider before policy is consulted, so a rule like this
    // matches nothing, ever, while reading exactly like a grant that works.
    rejects(
      (y) => y.replace('- "example.*"', '- "gmail.search"'),
      /names provider "gmail", but this row grants "example\.a"/,
    );
  });

  test('a bare * is allowed, because a row is already scoped to one connection', () => {
    expect(() => parseConfig(VALID.replace('- "example.*"', '- "*"'))).not.toThrow();
  });

  test('two grants for one connection fail rather than one winning silently', () => {
    const yaml = `${VALID}  - connection: example.a\n    allow:\n      - "example.echo"\n`;
    expect(() => parseConfig(yaml)).toThrow(/duplicate grant for "example\.a"/);
  });

  test('two accounts of the same provider get their own rows', () => {
    const yaml = VALID.replace(
      '  - connection: example.a\n    allow:\n      - "example.*"',
      '  - connection: example.work\n    allow:\n      - "example.*"\n' +
        '  - connection: example.home\n    allow:\n      - "example.echo"',
    );
    const { config } = parseConfig(yaml);

    expect(config.grants.map((grant) => grant.connection)).toEqual([
      'example.work',
      'example.home',
    ]);
    expect(config.grants[1]?.allow).toEqual([{ capability: 'example.echo' }]);
  });

  test('a subject listed twice fails, because the second row decides nothing', () => {
    const subject = 'lanes:3QBmAxJLLrYSMTVUIeCN1SKFbdD3';
    const yaml = `${VALID}members:\n  - { subject: ${subject}, role: owner }\n  - { subject: ${subject}, role: member }\n`;
    expect(() => parseConfig(yaml)).toThrow(/duplicate subject/);
  });

  test('a bare subject is refused before the schema even sees it', () => {
    // Two defences, and the outer one fires first: a Lanes subject is a
    // 28-character mixed-case alphanumeric string, which is exactly what
    // `secret-detection.ts` refuses as a high-entropy blob. That is why the
    // stored form carries a `lanes:` prefix — the colon takes it out of
    // `OPAQUE_TOKEN`'s character class, so saying which provider vouched for a
    // subject and being storable at all are the same decision.
    const yaml = `${VALID}members:\n  - { subject: 3QBmAxJLLrYSMTVUIeCN1SKFbdD3, role: owner }\n`;
    expect(() => parseConfig(yaml)).toThrow(/high-entropy string, which looks like a credential/);
  });

  test('and a prefixed one is accepted', () => {
    const yaml = `${VALID}members:\n  - { subject: lanes:3QBmAxJLLrYSMTVUIeCN1SKFbdD3, role: owner }\n`;
    expect(parseConfig(yaml).config.members[0]?.role).toBe('owner');
  });

  test('a subject that is neither is refused by the schema', () => {
    const yaml = `${VALID}members:\n  - { subject: someone, role: owner }\n`;
    expect(() => parseConfig(yaml)).toThrow(/lanes:<subject>/);
  });

  test('one skills grant is fine and two are refused', () => {
    // Not a limit of the store — a limit of the surface. A skill is a prompt,
    // selected by flat name with nothing to route on, so two instances would be
    // one name for two procedures (ADR-059).
    const one = VALID.replace('example.a', 'skills.main').replace('example.*', 'skills.*');
    expect(() => parseConfig(one)).not.toThrow();

    const two = `${one}  - connection: skills.work\n    allow:\n      - "skills.*"\n`;
    expect(() => parseConfig(two)).toThrow(/may grant one "skills" connection/);
  });

  test('two memory grants are fine, because its tools route on a connection', () => {
    const yaml =
      VALID.replace('example.a', 'memory.main').replace('example.*', 'memory.*') +
      '  - connection: memory.work\n    allow:\n      - "memory.*"\n';
    expect(() => parseConfig(yaml)).not.toThrow();
  });

  test('a default_target naming nothing is harmless, because nothing reads it', () => {
    // It used to be a validation failure. Nothing consults the key now
    // (ADR-037), so failing `check` on a stale value would teach that it still
    // matters — and every profile written before the change carries one.
    expect(() =>
      parseConfig(`${VALID}default_target: clod\n`, 'x.yaml'),
    ).not.toThrow();
  });
});

/**
 * The one id that moved out from under a profile — ADR-052.
 *
 * A refusal rather than a warning, because the failure it replaces is silent:
 * the row resolves to the built-in, reconcile calls it active, and the operator
 * loses their Google Tasks tools with nothing saying why.
 */
describe('a provider whose id has been renamed', () => {
  // Moved off the profile with the connections it inspects (ADR-057). The
  // evidence is the row's *account* — "is this really Google Tasks?" — and an
  // account lives in connections.yaml, so the check reads it there.
  const repair = 'lanes link doctor --fix --profile personal --workspace <name>';

  const withTasks = (id: string, account: string) =>
    assertNoRenamedProviders(
      [
        { id: 'a', provider: 'example', account: 'Scratch' },
        { id, provider: 'tasks', account },
      ],
      repair,
    );

  test('a tasks row wearing any other label is refused, and names google_tasks', () => {
    expect(() => withTasks('ada', 'ada.lovelace@example.com')).toThrow(/google_tasks/);
  });

  test('a label that is not an address is caught too — the case a heuristic missed', () => {
    // The check is "does it keep the built-in's own label", not "does it look
    // like an email". A row called "Work" is exactly as likely to be Google's.
    expect(() => withTasks('work', 'Work')).toThrow(/google_tasks/);
  });

  test('the built-in keeps its own label and passes', () => {
    expect(() => withTasks('main', 'Tasks')).not.toThrow();
  });

  test('the refusal offers the other fix too, for a hand-edited built-in row', () => {
    expect(() => withTasks('ada', 'ada.lovelace@example.com')).toThrow(/set account to Tasks/);
  });

  test('the refusal names the command that applies it, with the selection it needs', () => {
    expect(() => withTasks('ada', 'ada.lovelace@example.com')).toThrow(/doctor --fix/);
  });
});

describe('where a target deploys', () => {
  /**
   * A workspace declaring one deployable target.
   *
   * Against `workspaceSchema` rather than `parseConfig`, because that is where a
   * target lives since contract 2. A profile declares none (ADR-052), so a
   * `deploy:` block inside one is not a thing the profile loader can be asked
   * about any more.
   */
  const withTarget = (block: string) =>
    workspaceSchema.parse(
      parseYaml(
        'contract: 3\nworkspaces:\n  cloud:\n' +
          '    credentials: { adapter: gcp-secret-manager, project: my-project }\n' +
          '    storage: { adapter: s3, bucket: link-blobs }\n' +
          block,
      ),
    );

  test('a deploy block names its platform and defaults to the closed door', () => {
    const workspace = withTarget(
      '    deploy:\n      platform: cloudrun\n      project: my-project\n' +
        '      region: europe-west1\n      service: lanes-link\n',
    );

    expect(workspace.workspaces['cloud']?.deploy).toEqual({
      platform: 'cloudrun',
      project: 'my-project',
      region: 'europe-west1',
      service: 'lanes-link',
      // The closed door is the default, so a target that says nothing gets it.
      access: 'iam',
      // Scaling to zero is the default, and stays the default: a cold start is
      // under three seconds and the platform queues the request behind it.
      min_instances: 0,
      // And the ceilings, which a target that says nothing also gets. That is
      // the whole point of them being defaults rather than prompts: an operator
      // who never opens this block still deploys behind a bound on what a public
      // URL can spend.
      ...DEPLOY_DEFAULTS,
    });
  });

  test('the pre-deploy "cloudrun" block loads only through the legacy reader', () => {
    // It normalises to one shape, as it always did — but in `legacy.ts` now, on
    // the one path that reads a contract-1 file at all. Contract 2 has no reason
    // to carry a spelling nothing has written for two releases.
    const declared = legacyTargetSchema.parse(
      parseYaml(
        'credentials: { adapter: gcp-secret-manager, project: my-project }\n' +
          'storage: { adapter: s3, bucket: link-blobs }\n' +
          'cloudrun:\n  project: my-project\n  region: europe-west1\n  service: lanes-link\n',
      ),
    );

    expect(declared.deploy).toEqual({
      platform: 'cloudrun',
      project: 'my-project',
      region: 'europe-west1',
      service: 'lanes-link',
      access: 'iam',
      min_instances: 0,
      // The pre-`deploy` spelling predates these too, so `legacy.ts` supplies
      // them by hand — a migrated block that reached `deployPlan` without them
      // would send the string "undefined" to gcloud.
      ...DEPLOY_DEFAULTS,
    });
  });

  test('a "cloudrun" block is not read by the current contract', () => {
    // Not an error, and deliberately so: zod strips a key the schema does not
    // declare, so a stray one is inert rather than fatal. What it must not do is
    // quietly *deploy* from it, which is what this pins.
    const workspace = withTarget(
      '    cloudrun:\n      project: my-project\n      region: europe-west1\n      service: lanes-link\n',
    );

    expect(workspace.workspaces['cloud']?.deploy).toBeUndefined();
  });

  test('an unknown platform is refused at load, not at deploy', () => {
    expect(() =>
      withTarget(
        '    deploy:\n      platform: app-runner\n      region: eu-west-1\n      service: lanes-link\n',
      ),
    ).toThrow(/platform/);
  });

  test('an empty service name fails here rather than minutes into a build', () => {
    expect(() =>
      withTarget(
        '    deploy:\n      platform: cloudrun\n      project: p\n      region: r\n      service: ""\n',
      ),
    ).toThrow(/service/);
  });

  test('a missing project is not refused here — the driver that needs it says so', () => {
    // `project` means something to one platform and nothing to the next, on the
    // same reasoning as `credentials.project`.
    expect(() =>
      withTarget(
        '    deploy:\n      platform: cloudrun\n      region: europe-west1\n      service: lanes-link\n',
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
    expect(config.grants[0]?.allow[0]).toEqual({
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
    expect(() => parseConfig('contract: 3\n  bad: [indent')).toThrow(/could not parse YAML/);
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
  /**
   * Append a top-level `knowledge:` block.
   *
   * On the profile since contract 2, not under a target: it says where *this
   * profile's* memory and skills live, and a profile lives in exactly one target
   * (ADR-052), so the per-target spelling could no longer say anything extra.
   */
  const withKnowledge = (block: string): string => `${VALID}\n${block.trimStart()}\n`;

  test('is absent by default, which is what every existing profile relies on', () => {
    const { config } = parseConfig(VALID);
    expect(config.knowledge).toBeUndefined();
  });

  test('takes a repository and defaults the ref', () => {
    const { config } = parseConfig(
      withKnowledge('knowledge: { adapter: github, repo: my-org/my-notes }'),
    );

    expect(config.knowledge).toEqual({
      adapter: 'github',
      repo: 'my-org/my-notes',
      token_ref: 'knowledge/token',
    });
  });

  test('keeps a branch and a path when given', () => {
    const { config } = parseConfig(
      withKnowledge(
        'knowledge: { adapter: github, repo: my-org/my-notes, branch: trunk, path: context }',
      ),
    );

    expect(config.knowledge?.branch).toBe('trunk');
    expect(config.knowledge?.path).toBe('context');
  });

  test('normalises a path so one prefix has one spelling', () => {
    const { config } = parseConfig(
      withKnowledge('knowledge: { adapter: github, repo: my-org/my-notes, path: "/context/" }'),
    );

    expect(config.knowledge?.path).toBe('context');
  });

  test('refuses a URL where "owner/name" belongs', () => {
    expect(() =>
      parseConfig(
        withKnowledge(
          'knowledge: { adapter: github, repo: "https://github.com/my-org/my-notes" }',
        ),
      ),
    ).toThrow(/owner\/name/);
  });

  test('refuses a path that walks out of the repository', () => {
    expect(() =>
      parseConfig(
        withKnowledge('knowledge: { adapter: github, repo: my-org/my-notes, path: "../.." }'),
      ),
    ).toThrow(/\.\./);
  });

  test('refuses a token written inline instead of referenced', () => {
    // `secret-detection.ts` already knows the fine-grained prefix; this asserts
    // it covers the one field somebody would most plausibly paste one into.
    expect(() =>
      validateConfig(
        withKnowledge(
          'knowledge: { adapter: github, repo: my-org/my-notes, token_ref: github_pat_11ABCDE0Y0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmno }',
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
        'knowledge: { adapter: github, repo: my-org/my-notes, credentials: file, vault: blob }',
      ),
    );

    expect(config.knowledge).not.toHaveProperty('credentials');
    expect(config.knowledge).not.toHaveProperty('vault');
  });
});
