import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SecretStore } from '#secrets';
import {
  defineProvider,
  rotatableCredentialRefs,
  type ProviderManifest,
} from '#connectivity';
import { CredentialOAuthProvider } from '#connectivity/auth/index.ts';
import { DEPLOY_DEFAULTS, layout, type Config, type DeployConfig, type TargetConfig } from '#profile';
import { ownClientRefsFor } from '#registry';
import { encodeRef } from './adapters/gcp-secret-manager.ts';
import { provisionSteps } from './gcp/provision.ts';
import { openStorage } from './target.ts';

/**
 * That the keys a deployed instance writes are the keys it is granted.
 *
 * These are two files that never mention each other. `gcp/provision.ts` writes
 * an IAM condition naming the object prefixes a revision may write; `target.ts`
 * and `profile/layout.ts` decide what those object names actually are. Nothing
 * connected them, and they disagreed: every path carried a leading `./`, so the
 * real key was `objects/./data/personal/state.kv/…` against a grant on
 * `objects/data/`, and provider blobs were written to the bucket root with no
 * prefix at all.
 *
 * The cost of that disagreement is not a failed unit test. It is a revision that
 * builds, deploys, reports healthy, and then 403s on the first thing it writes —
 * which is its boot reconcile, so the container exits 1 and `gcloud run deploy`
 * fails several minutes and one image push later. This test is cheap and pins
 * both halves at once.
 *
 * It evaluates the condition rather than string-matching it: the expression is
 * an `||` of `startsWith` calls, which is little enough CEL to run honestly.
 */

const BUCKET = 'lanes-link-demo-data';
const PROFILE = 'personal';
const OBJECTS = `projects/_/buckets/${BUCKET}/objects/`;

const cloudrun = {
  platform: 'cloudrun',
  project: 'my-project',
  region: 'europe-west1',
  service: 'lanes-link',
  access: 'public',
  service_account: 'lanes-link-run@my-project.iam.gserviceaccount.com',
  min_instances: 0,
  ...DEPLOY_DEFAULTS,
} as const satisfies DeployConfig;

const target: TargetConfig = {
  credentials: { adapter: 'gcp-secret-manager', project: 'my-project' },
  storage: { adapter: 'gcs', bucket: BUCKET },
  vault: { adapter: 'secret' },
  deploy: cloudrun,
} as TargetConfig;

/**
 * The object keys the endpoint really writes, taken from the adapter itself.
 *
 * Driven through `openStorage` and a stubbed `fetch` rather than recomposed
 * here from `layout` — a test that rebuilds the key the same way the code does
 * agrees with the code by construction, including when both are wrong. Reading
 * the name off the upload URL is the only version of this that can fail.
 *
 * Each entry names its area exactly as its caller does: `openState` and
 * `openAudit` in `target.ts`, `skillStore` in `cli/runtime/open.ts`, and — the
 * one that was broken — a provider's own store, which asks for no area at all.
 */
const AREAS: Record<string, [string | undefined, string]> = {
  'connection state': [layout.state(), 'connections.v1/gmail.ada_lovelace'],
  'the audit log': [layout.audit(), '2026/08/13/1755075600000-abc.json'],
  'a memory entry': [undefined, 'memory/main/note.md'],
  'an attachment': [undefined, 'gmail/ada_lovelace/attachments/x.pdf'],
  'a skill': [layout.skills(PROFILE), 'review-diff/SKILL.md'],
};

const WRITES: Record<string, string> = {};

/** The URL the store asks for a listing, captured from the adapter itself. */
let LISTED = '';

/** What IAM evaluates a listing against: the bucket, not anything in it. */
const BUCKET_RESOURCE = `projects/_/buckets/${BUCKET}`;

beforeAll(async () => {
  // Keeps `ApplicationDefaultCredentials` off the network and out of the
  // operator's own gcloud credentials: with this set it returns the override
  // and never mints anything.
  process.env['GOOGLE_ACCESS_TOKEN'] = 'test-token';

  const config = { instance: { profile: PROFILE }, targets: { cloud: target } } as unknown as Config;
  const captured: string[] = [];
  const real = globalThis.fetch;

  // Stubbed before the factory is built: `createGcsBlobStore` resolves
  // `globalThis.fetch` once, at construction.
  globalThis.fetch = (async (url: string | URL | Request) => {
    captured.push(String(url instanceof Request ? url.url : url));
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const storage = await openStorage(
      { declared: target, config, root: '/nowhere', target: 'cloud' },
      {} as SecretStore,
    );

    for (const [what, [area, key]] of Object.entries(AREAS)) {
      captured.length = 0;
      await storage(area).put(key, new Uint8Array([1]));
      WRITES[what] = new URL(captured[0]!).searchParams.get('name')!;
    }

    // And one listing, which is the call that has no object in it at all.
    captured.length = 0;
    await storage(layout.state()).list('connections.v1/');
    LISTED = captured[0]!;
  } finally {
    globalThis.fetch = real;
  }
});

afterAll(() => {
  delete process.env['GOOGLE_ACCESS_TOKEN'];
});

/** What ADR-007 says a deployed instance must never rewrite. */
const READS = {
  'its own profile': `profiles/${PROFILE}.yaml`,
  'the workspace file': 'lanes-link.yaml',
  // Inside `data/` since ADR-030, so the write condition has to carve it back
  // out rather than simply not mentioning it.
  'a provider manifest': `${layout.providers()}/acme.yaml`,
};

/** The CEL of the one conditioned binding whose title carries `name`. */
async function conditionTitled(name: string): Promise<string> {
  const steps = await provisionSteps({
    deploy: cloudrun,
    declared: target,
    target: 'cloud',
    profiles: [PROFILE],
  });
  const step = steps.find((candidate) => candidate.argv.join(' ').includes(name));

  // `title=…,expression=…`; only the expression is evaluable.
  const condition = step!.argv[step!.argv.indexOf('--condition') + 1]!;
  const marker = 'expression=';
  return condition.slice(condition.indexOf(marker) + marker.length);
}

const writeCondition = (): Promise<string> => conditionTitled('owns-its-data');
const readCondition = (): Promise<string> => conditionTitled('reads-its-config');

/**
 * Evaluate the shipped condition for one resource name.
 *
 * The subset of CEL these expressions use — `||`, `&&`, `!`, parentheses,
 * `startsWith`, `matches`, and `==` against a string literal — is also valid
 * JavaScript, so the expression runs rather than being pattern-matched. That
 * matters more since the write grant stopped being a flat `||` of prefixes: an
 * exclusion is exactly the kind of clause a regex scan reads straight past,
 * reporting a permission the revision does not have.
 *
 * `name` is a `String` object so the methods can hang off it while
 * `resource.name == "…"` still compares equal by coercion.
 */
function permits(condition: string, key: string): boolean {
  return permitsResource(condition, `${OBJECTS}${key}`);
}

/** The same, for a resource name that is not an object under this bucket. */
function permitsResource(condition: string, full: string): boolean {
  const name = Object.assign(new String(full), {
    contains: (needle: string) => full.includes(needle),
    matches: (pattern: string) => new RegExp(pattern).test(full),
  });

  return new Function('resource', `return ${condition};`)({ name }) === true;
}

/**
 * The permission no object prefix can carry.
 *
 * `storage.objects.list` is checked against the **bucket**, never against an
 * object — a prefixed listing is one call to the bucket with a filter on it,
 * not a walk of matching resources — so a condition written in terms of
 * `objects/…` cannot grant it. Google documents the consequence outright: IAM
 * conditions cannot restrict object listing by prefix.
 *
 * It stayed hidden for as long as the read binding said `expression=true`,
 * which matches the bucket as readily as an object. The deploy that finally
 * removed that binding rolled a revision which could not list its own
 * workspace, exited 1 during the health check, and left the endpoint in front
 * of it unable to list anything either — every `tasks`, `memory` and `assets`
 * call 403'd, because listing had never been granted by anything else.
 */
describe('listing, which is checked against the bucket rather than an object', () => {
  test('the store asks the bucket for it, with the prefix as a query parameter', async () => {
    // Taken off the adapter rather than asserted about it: this is the fact
    // that decides which resource IAM evaluates, and it is not visible in any
    // object name.
    const url = new URL(LISTED);

    expect(url.pathname).toBe(`/storage/v1/b/${BUCKET}/o`);
    expect(url.searchParams.get('prefix')).toContain('connections.v1/');
  });

  test('so the read grant has to admit the bucket itself, and does', async () => {
    expect(permitsResource(await readCondition(), BUCKET_RESOURCE)).toBe(true);
  });

  test('and nothing else does, which is why removing that clause takes listing with it', async () => {
    // The write grant is every other binding this deploy makes on the bucket.
    // If this one ever passes, the clause above has a second source and the
    // test above stops being load-bearing.
    expect(permitsResource(await writeCondition(), BUCKET_RESOURCE)).toBe(false);
  });

  test('admitting the bucket does not admit an object outside the config', async () => {
    // The whole concession is the *names* of what is in the bucket. Reads stay
    // where ADR-007 puts them.
    const condition = await readCondition();

    expect(permitsResource(condition, `${OBJECTS}data/${PROFILE}/memory/main/note.md`)).toBe(false);
    expect(permitsResource(condition, `${OBJECTS}data/${PROFILE}/credentials.enc`)).toBe(false);
  });
});

describe('what the revision is granted, against what it writes', () => {
  test('every object the endpoint writes falls inside the write grant', async () => {
    const condition = await writeCondition();

    for (const [what, key] of Object.entries(WRITES)) {
      expect({ what, key, permitted: permits(condition, key) }).toEqual({
        what,
        key,
        permitted: true,
      });
    }
  });

  test('the condition uses only what Cloud Storage IAM actually implements', async () => {
    // `permits` above runs the expression as JavaScript, which is what makes it
    // an honest evaluator of *meaning*. It was a dishonest evaluator of
    // *availability*, and this expression was refused twice on that gap.
    //
    // Cloud Storage IAM conditions take a restricted CEL subset: `resource.type`,
    // `resource.name` with `startsWith`, `endsWith` and `==`, and the date
    // functions. No `matches`. JavaScript has one, so a regex condition
    // evaluated perfectly here and came back from Google as `undeclared
    // reference to 'matches'`.
    //
    // Before that it was refused for a second reason — the regex was written
    // `providers\\.d/`, and `\\.` is not a CEL escape, so the string literal
    // failed to parse. Two spellings, two errors, and the same silence either
    // way: both bindings carry `tolerateFailure`, so a deploy printed a warning
    // and left whatever conditions the bucket already had. On a real deployment
    // that meant `expression=true` on the read binding — every object in the
    // bucket, which is precisely the narrowing the step title claims to make.
    //
    // So this asserts the subset rather than the instance.
    const allowed = /^(resource\.name\.(startsWith|endsWith)\(|resource\.name ==|resource\.type)/;
    for (const condition of [await writeCondition(), await readCondition()]) {
      // No escape can survive CEL's unescaping wrong if there is none.
      expect({ condition, backslash: condition.includes('\\') }).toEqual({
        condition,
        backslash: false,
      });

      const calls = condition.match(/[a-z_]+(\.[a-z_]+)*\s*\(/gi) ?? [];
      const unsupported = calls
        .map((call) => call.replace(/\s*\($/, ''))
        .filter((name) => !/^resource\.name\.(startsWith|endsWith)$/.test(name));
      expect({ condition, unsupported }).toEqual({ condition, unsupported: [] });

      // And every clause is one of the shapes the subset names.
      for (const clause of condition.split(/\s*(?:\|\||&&)\s*/)) {
        const bare = clause.replace(/^[!(]+/, '').replace(/\)+$/, '');
        if (bare.startsWith('title=') || bare.startsWith('expression=')) continue;
        expect({ clause: bare, allowed: allowed.test(bare) }).toEqual({
          clause: bare,
          allowed: true,
        });
      }
    }
  });

  test('no key carries a "./" segment a bucket would take literally', async () => {
    // The leading `./` that `layout.ts` used to produce. `path.resolve` drops
    // it; object storage does not, and creates a directory named `.`.
    for (const key of Object.values(WRITES)) expect(key).not.toContain('./');
  });

  test('the config the endpoint reads stays outside the write grant', async () => {
    // ADR-007: a deployed instance never mutates its own configuration. Once the
    // workspace moved into the bucket (ADR-023) this condition is the only thing
    // still enforcing it, so a widened grant has to fail here.
    const condition = await writeCondition();

    for (const [what, key] of Object.entries(READS)) {
      expect({ what, permitted: permits(condition, key) }).toEqual({ what, permitted: false });
    }
  });
});

describe('the vault, which is the one thing a revision writes back to its store', () => {
  // Handed in, the way `deploy` hands it in. The vault document is named per
  // vault connection (ADR-059), so only `prepare.ts` — which has the profile
  // configs — can work it out. `provisionSteps` naming `vault/document` itself
  // is the defect these tests used to pin: it created and granted one secret
  // while `openVault` asked for another, and the revision died on
  // `PERMISSION_DENIED` before it could listen on its port.
  const VAULT = 'vault/main';
  const provision = (declared: TargetConfig) =>
    provisionSteps({
      deploy: cloudrun,
      declared,
      target: 'cloud',
      profiles: [PROFILE],
      rotatable: [VAULT],
    });

  test('the document secret is created here, so the revision never needs secrets.create', async () => {
    // `secrets.create` is project-level: a revision holding it could mint
    // credential refs of its own. Creating the container up front leaves it
    // needing only "add a version" on one secret.
    const steps = await provision(target);
    const create = steps.find(
      (step) => step.argv[0] === 'secrets' && step.argv[1] === 'create',
    );

    expect(create?.argv).toContain('vault__main');
    expect(create?.tolerateFailure).toBe(true);
  });

  test('the write grant is on that one secret, which needs no condition to be narrow', async () => {
    const steps = await provision(target);
    const binding = steps.find(
      (step) => step.argv[0] === 'secrets' && step.argv[1] === 'add-iam-policy-binding',
    )!;

    expect(binding.argv[2]).toBe('vault__main');
    expect(binding.argv).toContain('roles/secretmanager.secretVersionAdder');
  });

  test('a target with no vault contributes no ref, so nothing extra is granted', async () => {
    // The *decision* moved to `prepare.ts` with the profile configs; what stays
    // provision's is that it grants exactly what it was handed and invents
    // nothing. `rotatableRefs` is what turns "this target has no vault" into an
    // empty list, and `readableRefs` is covered beside it.
    const { vault: _vault, ...withoutVault } = target;
    const roles = (
      await provisionSteps({
        deploy: cloudrun,
        declared: withoutVault as TargetConfig,
        target: 'cloud',
        profiles: [PROFILE],
        rotatable: [],
      })
    )
      .flatMap((step) => step.argv)
      .filter((argument) => argument.startsWith('roles/'));

    expect(roles).not.toContain('roles/secretmanager.secretVersionAdder');
  });
});

/**
 * The same question one store over, and the one that was answered wrong.
 *
 * Everything above pins object keys against an IAM condition. Credentials had
 * the identical disagreement and no test: `deploy` granted read on the store and
 * write on the vault, while the OAuth refresh path rewrote a connection's token
 * blob every time an access token expired. Both halves looked right in
 * isolation — the grant was narrow on purpose, and persisting a refreshed token
 * is obviously correct — so the endpoint deployed, reported healthy, served for
 * an hour, and then 403'd on `secretmanager.secrets.create` for the rest of its
 * life. See ADR-026.
 *
 * Driven through `CredentialOAuthProvider` for the same reason `WRITES` above is
 * driven through `openStorage`: the ref it writes is private to it, and a test
 * that recomposes the ref agrees with the code by construction, including when
 * both are wrong.
 */
const CONNECTION = 'ada_lovelace';

/** Gmail's shape: the operator supplies the client, so only tokens are ours. */
const manualProvider = defineProvider({
  id: 'gmail',
  name: 'Gmail',
  connector: {
    kind: 'http',
    base_url: 'https://gmail.googleapis.com',
    openapi: 'providers/gmail.openapi.json',
  },
  auth: { kind: 'oauth', registration: 'manual', app: 'google', token_url: 'https://oauth2.test/token' },
  setup: {
    // A manual registration means the operator supplies the client, so the
    // manifest has to say what to supply. Both land in `oauth_apps`, shared
    // across every Google provider — which is exactly the ref no revision may
    // rewrite.
    prompts: [
      { key: 'client_id', label: 'client ID', secret: false, credential_ref: 'google/client_id' },
      { key: 'client_secret', label: 'client secret', secret: true, credential_ref: 'google/client_secret' },
    ],
  },
});

/** Notion's shape: registered dynamically, so the registration is ours to keep. */
const dynamicProvider = defineProvider({
  id: 'notion',
  name: 'Notion',
  connector: { kind: 'mcp', endpoint: 'https://mcp.notion.test/mcp' },
  auth: { kind: 'oauth' },
});

/** Every ref the provider writes when it is serving, read off the calls it makes. */
async function refsWrittenWhileServing(
  manifest: ProviderManifest,
  { registers }: { registers: boolean },
): Promise<string[]> {
  const written: string[] = [];
  const credentials = {
    async get() {
      return null;
    },
    async set(ref: string) {
      written.push(ref);
    },
  } as unknown as SecretStore;

  const provider = new CredentialOAuthProvider({ manifest, connectionId: CONNECTION, credentials });

  // What a refresh does, on the path an ordinary read takes.
  await provider.saveTokens({ access_token: 'fresh', refresh_token: 'r', expires_in: 3599 });

  // What the SDK does if it has to re-register mid-flight, which only a
  // dynamically registered provider can: a manual client is the operator's and
  // `clientInformation()` hands the stored one back rather than registering.
  if (registers) await provider.saveClientInformation({ client_id: 'c' });

  return written;
}

describe('the credentials a revision rotates, against what it is bound to', () => {
  const provisionWith = async (rotatable: readonly string[]) =>
    provisionSteps({ deploy: cloudrun, declared: target, target: 'cloud', rotatable });

  const boundSecrets = (steps: Awaited<ReturnType<typeof provisionSteps>>): string[] =>
    steps
      .filter(
        (step) =>
          step.argv[0] === 'secrets' &&
          step.argv[1] === 'add-iam-policy-binding' &&
          step.argv.includes('roles/secretmanager.secretVersionAdder'),
      )
      .map((step) => step.argv[2]!);

  test('every ref the refresh path writes is one the deploy bound', async () => {
    for (const [manifest, registers] of [
      [manualProvider, false],
      [dynamicProvider, true],
    ] as const) {
      const written = await refsWrittenWhileServing(manifest, { registers });
      const rotatable = rotatableCredentialRefs(manifest, CONNECTION);
      const bound = boundSecrets(await provisionWith(rotatable));

      // Written first, because it is the list that is true whatever anyone
      // intended: these calls happen while a request is in flight.
      expect(written.length).toBeGreaterThan(0);
      for (const ref of written) {
        expect({ provider: manifest.id, ref, bound: bound.includes(encodeRef(ref)) }).toEqual({
          provider: manifest.id,
          ref,
          bound: true,
        });
      }
    }
  });

  test('the token blob is bound under the encoded id, not the reference', async () => {
    // The `/` → `__` encoding lives inside the adapter, and gcloud takes a
    // secret id. A binding written with the raw ref names a secret that cannot
    // exist, and every step here tolerates failure, so it would have gone by in
    // silence.
    const bound = boundSecrets(await provisionWith(['gmail/ada_lovelace']));

    expect(bound).toContain('gmail__ada_lovelace');
  });

  test('each rotatable secret is created here too, for the reason the vault one is', async () => {
    const steps = await provisionWith(['gmail/ada_lovelace', 'vault/main']);
    const created = steps
      .filter((step) => step.argv[0] === 'secrets' && step.argv[1] === 'create')
      .map((step) => step.argv[2]!);

    // A binding cannot attach to a secret that does not exist, and a connection
    // authorised after the last deploy has no secret up here yet.
    expect(created).toContain('gmail__ada_lovelace');
    expect(created).toContain('vault__main');
  });

  test('a manual client stays the operator\'s, and is never bound', async () => {
    // Gmail and Drive share one `oauth_apps` entry. A revision that could
    // rewrite it would break every other connection authorised against it, and
    // nothing on the serve path ever wants to.
    const rotatable = rotatableCredentialRefs(manualProvider, CONNECTION);

    expect(rotatable).toEqual(['gmail/ada_lovelace']);
    expect(boundSecrets(await provisionWith(rotatable))).not.toContain('google__client');
  });

  test('nothing anywhere grants the permission that would let it mint a ref', async () => {
    // The recommendation this replaced was `roles/secretmanager.admin`, which
    // does fix the symptom and hands a deployed instance the ability to create
    // and destroy credentials across the whole project.
    const roles = (
      await provisionSteps({
        deploy: cloudrun,
        declared: target,
        target: 'cloud',
        rotatable: ['gmail/ada_lovelace', 'notion/client'],
        readable: ['gmail/ada_lovelace', 'profile/token'],
      })
    )
      .flatMap((step) => step.argv)
      .filter((argument) => argument.startsWith('roles/secretmanager.'));

    expect(roles).not.toContain('roles/secretmanager.admin');
    expect(roles).not.toContain('roles/secretmanager.secretCreator');
    expect(new Set(roles)).toEqual(
      new Set(['roles/secretmanager.secretAccessor', 'roles/secretmanager.secretVersionAdder']),
    );
  });

  test('read is bound per secret, so an SSRF cannot reach the rest of the project', async () => {
    // This was a project-level `secretAccessor`. Nothing about the serving path
    // needed it — reads go by explicit ref, and `secretAccessor` never carried
    // `secrets.list` — so the only thing it bought was reach into every other
    // secret sharing the project, which `askProject` lets an operator choose.
    const steps = await provisionSteps({
      deploy: cloudrun,
      declared: target,
      target: 'cloud',
      rotatable: [],
      readable: ['gmail/ada_lovelace', 'vault/key'],
    });

    const accessor = steps.filter((step) =>
      step.argv.includes('roles/secretmanager.secretAccessor'),
    );

    // One per ref, each naming its own secret, and none of them project-wide.
    expect(accessor.map((step) => step.argv[2])).toEqual(['gmail__ada_lovelace', 'vault__key']);
    for (const step of accessor) {
      expect(step.argv[0]).toBe('secrets');
      expect(step.argv).not.toContain('projects');
    }
  });
});

describe('the client a revision signs a refresh with, where the profile holds one', () => {
  const manifestOf = (broker?: object) =>
    defineProvider({
      id: 'vendor_mail',
      name: 'Vendor Mail',
      connector: { kind: 'http', base_url: 'https://api.test', openapi: './t.json' },
      auth: {
        kind: 'oauth',
        registration: 'manual',
        app: 'vendor',
        scopes: ['a'],
        authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
        token_url: 'https://oauth2.example.com/token',
        ...(broker ? { broker } : {}),
      },
      ...(broker
        ? {}
        : {
            setup: {
              prompts: [
                { key: 'client_id', label: 'Client id', credential_ref: 'vendor/client_id' },
              ],
            },
          }),
    });

  const declaredApps = {
    vendor: { client_id_ref: 'vendor/client_id', client_secret_ref: 'vendor/client_secret' },
  };

  test('a declared client is readable, because the refresh path signs with it', () => {
    // It was not, and the failure was silent in the worst way: the adapter
    // answers null only on a 404, so an *unbound* secret is a 403 that throws.
    // The revision served until its access token expired and then failed every
    // call, an hour after reporting healthy.
    expect(ownClientRefsFor(manifestOf(), declaredApps)).toEqual([
      'vendor/client_id',
      'vendor/client_secret',
    ]);
  });

  test('a profile that declares none binds none', () => {
    // Which is every profile that authorises against a broker.
    expect(ownClientRefsFor(manifestOf({ url: 'https://api.example.com/b', operator: 'X' }), {})).toEqual([]);
  });

  test('readable is not rotatable: a revision never rewrites the operator’s client', () => {
    // ADR-026's line. Sharing one entry across a vendor's providers is exactly
    // why: rewriting it would break every other connection authorised against it.
    const brokered = manifestOf({ url: 'https://api.example.com/b', operator: 'X' });

    expect(rotatableCredentialRefs(brokered, CONNECTION)).toEqual(['vendor_mail/ada_lovelace']);
    expect(rotatableCredentialRefs(manifestOf(), CONNECTION)).toEqual(['vendor_mail/ada_lovelace']);
  });
});
