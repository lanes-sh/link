import { describe, expect, test } from 'bun:test';
import {
  ApplicationDefaultCredentials,
  GcpSecretManagerStore,
  decodeRef,
  encodeRef,
} from './gcp-secret-manager.ts';

/**
 * Secret Manager, against a fake that speaks its REST API.
 *
 * The fake is the whole surface the adapter uses — create, add version,
 * access, list with pagination, delete — rather than a stub per test, so a call
 * the adapter gets wrong (a bad path, a missing body, an unhandled 409) fails
 * here instead of on the first deploy.
 */

const PROJECT = 'lanes-link-test';

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

/** Two per page, so pagination is exercised by any list of three. */
const PAGE = 2;

/**
 * What the caller may do, so a test can hold the identity a revision actually
 * runs as.
 *
 * Denied is checked **before** existence, which is Secret Manager's own order
 * and not a simplification: a `secrets.create` against a secret that is already
 * there answers `PERMISSION_DENIED`, never `ALREADY_EXISTS`. That is what a
 * deployed instance proved — it 403'd creating a secret it had just read.
 * A fake that answered 409 there would make the adapter look correct.
 */
interface Iam {
  readonly denied?: readonly string[];
}

function fakeSecretManager(seed: Record<string, string> = {}, iam: Iam = {}) {
  const secrets = new Map<string, string[]>();
  for (const [id, value] of Object.entries(seed)) {
    secrets.set(id, [Buffer.from(value, 'utf8').toString('base64')]);
  }

  const calls: Recorded[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failure = (status: number, statusName: string, message: string): Response =>
    json({ error: { code: status, status: statusName, message } }, status);
  const denied = (permission: string): Response | undefined =>
    iam.denied?.includes(permission)
      ? failure(
          403,
          'PERMISSION_DENIED',
          `Permission '${permission}' denied for resource ` +
            `'projects/${PROJECT}' (or it may not exist).`,
        )
      : undefined;

  const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: headers.get('authorization'),
    });

    if (!headers.get('authorization')?.startsWith('Bearer ')) {
      return failure(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    }

    const path = url.pathname.replace(`/v1/projects/${PROJECT}/secrets`, '');

    if (method === 'POST' && path === '') {
      const refused = denied('secretmanager.secrets.create');
      if (refused) return refused;

      const id = url.searchParams.get('secretId')!;
      if (secrets.has(id)) return failure(409, 'ALREADY_EXISTS', `Secret [${id}] already exists.`);
      secrets.set(id, []);
      return json({ name: `projects/${PROJECT}/secrets/${id}` });
    }

    if (method === 'GET' && path === '') {
      const refused = denied('secretmanager.secrets.list');
      if (refused) return refused;

      const ids = [...secrets.keys()].sort();
      const from = Number(url.searchParams.get('pageToken') ?? '0');
      const page = ids.slice(from, from + PAGE);
      return json({
        secrets: page.map((id) => ({ name: `projects/${PROJECT}/secrets/${id}` })),
        ...(from + PAGE < ids.length ? { nextPageToken: String(from + PAGE) } : {}),
      });
    }

    const addVersion = path.match(/^\/([^/:]+):addVersion$/);
    if (method === 'POST' && addVersion) {
      const refused = denied('secretmanager.versions.add');
      if (refused) return refused;

      const id = addVersion[1]!;
      const versions = secrets.get(id);
      if (!versions) return failure(404, 'NOT_FOUND', `Secret [${id}] not found.`);
      versions.push((JSON.parse(String(init?.body)) as { payload: { data: string } }).payload.data);
      return json({ name: `projects/${PROJECT}/secrets/${id}/versions/${versions.length}` });
    }

    const access = path.match(/^\/([^/]+)\/versions\/latest:access$/);
    if (method === 'GET' && access) {
      const refused = denied('secretmanager.versions.access');
      if (refused) return refused;

      const versions = secrets.get(access[1]!) ?? [];
      if (versions.length === 0) {
        return failure(404, 'NOT_FOUND', 'Secret Version [latest] not found.');
      }
      return json({ payload: { data: versions.at(-1) } });
    }

    const latest = path.match(/^\/([^/]+)\/versions\/latest$/);
    if (method === 'GET' && latest) {
      const versions = secrets.get(latest[1]!) ?? [];
      if (versions.length === 0) {
        return failure(404, 'NOT_FOUND', 'Secret Version [latest] not found.');
      }
      return json({
        name: `projects/${PROJECT}/secrets/${latest[1]}/versions/latest`,
        state: 'ENABLED',
      });
    }

    const single = path.match(/^\/([^/:]+)$/);
    if (method === 'DELETE' && single) {
      const id = single[1]!;
      if (!secrets.delete(id)) return failure(404, 'NOT_FOUND', `Secret [${id}] not found.`);
      return json({});
    }

    return failure(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`);
  }) as typeof globalThis.fetch;

  return { fetch, secrets, calls };
}

function store(seed: Record<string, string> = {}, iam: Iam = {}) {
  const api = fakeSecretManager(seed, iam);
  return {
    api,
    store: new GcpSecretManagerStore({
      project: PROJECT,
      fetch: api.fetch,
      tokens: {
        async token() {
          return 'test-access-token';
        },
      },
    }),
  };
}

describe('reference encoding', () => {
  test('round-trips every shape a credential reference can take', () => {
    for (const ref of [
      'gmail/main',
      'profile/token',
      'google/client_secret',
      'icloud_mail/main',
      'a/b/c',
      'gmail/main-2',
      'x9/y0',
    ]) {
      expect(decodeRef(encodeRef(ref))).toBe(ref);
    }
  });

  test('produces an id Secret Manager accepts', () => {
    // The whole reason an encoding exists: `/` is legal in a reference and
    // illegal in a secret id.
    expect(encodeRef('gmail/main')).toBe('gmail__main');
    expect(encodeRef('a/b/c')).toBe('a__b__c');
    expect(encodeRef('google/client_secret')).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
  });

  test('refuses a reference the encoding cannot represent, rather than colliding', () => {
    // `a/b__c` and `a/b/c` would share one secret. Two credentials in one slot
    // is a silent overwrite of a refresh token, so this refuses at the boundary.
    expect(() => encodeRef('a/b__c')).toThrow(/cannot be stored in Secret Manager/);
    expect(() => encodeRef('a/b_/c')).toThrow(/cannot be stored in Secret Manager/);
  });

  test('still rejects a malformed reference before encoding it', () => {
    expect(() => encodeRef('nonamespace')).toThrow(/Malformed secret reference/);
    expect(() => encodeRef('../escape/x')).toThrow(/Malformed secret reference/);
  });
});

describe('round trip', () => {
  test('stores, reads, lists, and deletes', async () => {
    const { store: credentials } = store();

    expect(await credentials.get('gmail/main')).toBeNull();
    expect(await credentials.has('gmail/main')).toBe(false);

    await credentials.set('gmail/main', 'refresh-token-main');
    await credentials.set('gmail/side', 'refresh-token-side');
    await credentials.set('profile/token', 'llk_abc');

    expect(await credentials.get('gmail/main')).toBe('refresh-token-main');
    expect(await credentials.has('gmail/main')).toBe(true);
    // Paginated by the fake at two per page, so this takes three requests.
    expect(await credentials.list()).toEqual(['gmail/main', 'gmail/side', 'profile/token']);
    expect(await credentials.list('gmail/')).toEqual(['gmail/main', 'gmail/side']);

    await credentials.delete('gmail/side');
    expect(await credentials.get('gmail/side')).toBeNull();
    expect(await credentials.list()).toEqual(['gmail/main', 'profile/token']);
  });

  test('overwriting adds a version rather than replacing the secret', async () => {
    const { store: credentials, api } = store();

    await credentials.set('gmail/main', 'first');
    await credentials.set('gmail/main', 'second');

    expect(await credentials.get('gmail/main')).toBe('second');
    // Secret Manager keeps history, and that is a feature here: a botched
    // rotation is recoverable from the console.
    expect(api.secrets.get('gmail__main')).toHaveLength(2);
  });

  test('a value survives the base64 payload encoding intact', async () => {
    const { store: credentials } = store();
    // Refresh tokens are JSON blobs in this system, and an app password can
    // carry anything at all.
    const value = JSON.stringify({ refresh_token: 'ü/+=\n"quoted"', expires_at: 1 });

    await credentials.set('gmail/main', value);
    expect(await credentials.get('gmail/main')).toBe(value);
  });

  test('deleting a reference that was never stored is a no-op', async () => {
    const { store: credentials } = store();
    await credentials.delete('gmail/never');
    expect(await credentials.list()).toEqual([]);
  });

  test('the encoding never escapes the adapter', async () => {
    const { store: credentials, api } = store();
    await credentials.set('icloud_mail/main', 'app-password');

    // On the wire it is a legal secret id; to every caller it is the reference
    // they wrote. `lanes link status` breaks if these ever diverge.
    expect([...api.secrets.keys()]).toEqual(['icloud_mail__main']);
    expect(await credentials.list()).toEqual(['icloud_mail/main']);
  });
});

describe('a project holding more than this system put there', () => {
  test('list skips secrets that are not credential references', async () => {
    const { store: credentials } = store({
      gmail__main: 'a',
      'cloud-build-key': 'b',
      SOME_OTHER_APP: 'c',
    });

    // A shared project is normal. Reporting a foreign secret as a credential
    // would put an unreadable ref in front of every `doctor` run.
    expect(await credentials.list()).toEqual(['gmail/main']);
  });
});

describe('what it sends', () => {
  test('every request carries the bearer token', async () => {
    const { store: credentials, api } = store();
    await credentials.set('gmail/main', 'x');
    await credentials.get('gmail/main');

    expect(api.calls.length).toBeGreaterThan(0);
    for (const call of api.calls) expect(call.authorization).toBe('Bearer test-access-token');
  });

  test('has() asks only for what a revision is granted', async () => {
    // It used to read version *metadata* instead, so as not to pull plaintext
    // across the network for an existence check. That needs
    // `secretmanager.versions.get`, and the role a deployed revision holds —
    // `roles/secretmanager.secretAccessor` — grants exactly
    // `secretmanager.versions.access` and not that one. Every deployment died on
    // its boot reconcile with a 403 naming a permission nobody had asked for.
    //
    // The fix is not a wider grant: `roles/secretmanager.viewer` would let the
    // revision enumerate every secret in a project it may be sharing. So this
    // pins the call shape, because the cost of getting it wrong is invisible
    // until something is actually deployed.
    const { store: credentials, api } = store({ gmail__main: 'refresh-token' });

    expect(await credentials.has('gmail/main')).toBe(true);
    expect(api.calls.every((call) => call.path.includes(':access'))).toBe(true);
  });

  test('has() is false for a ref that is not stored, rather than throwing', async () => {
    const { store: credentials } = store({});

    expect(await credentials.has('gmail/absent')).toBe(false);
  });

  test('a concurrent create is absorbed rather than failing the write', async () => {
    // Two writers reaching a ref that does not exist yet. Both find nothing to
    // add a version to, both create, and one of them loses — the loser gets
    // ALREADY_EXISTS and must still land its version rather than treating the
    // race it lost as a failure.
    //
    // Run as the race instead of asserting a create call was made: that older
    // shape passed for a `set` that created every single time, which is the
    // permission a deployed revision does not have.
    const { store: credentials, api } = store();

    await Promise.all([credentials.set('gmail/main', 'a'), credentials.set('gmail/main', 'b')]);

    expect(api.secrets.get('gmail__main')).toHaveLength(2);
    expect(await credentials.get('gmail/main')).toBeOneOf(['a', 'b']);
  });
});

/**
 * The identity a deployed revision actually holds.
 *
 * `roles/secretmanager.secretAccessor` on the project, and
 * `roles/secretmanager.secretVersionAdder` on the individual secrets it rotates.
 * Nothing else: `secrets.create` is project-level and would let a revision mint
 * credential references of its own, which is the guarantee ADR-022 exists to
 * keep.
 *
 * Every test above runs as the operator, who holds all of it, so the adapter
 * could ask for a permission no deployment has and stay green for a year. It
 * did — `set` created before it added, unconditionally, so the first token
 * refresh after an access token expired 403'd on `secrets.create` and took the
 * caller's request with it. Reading mail is a write, and this is the identity
 * that write runs as.
 */
const REVISION: Iam = {
  denied: [
    'secretmanager.secrets.create',
    'secretmanager.secrets.list',
    'secretmanager.secrets.delete',
  ],
};

describe('as a deployed revision, which may add a version and not create a secret', () => {
  test('rotates a stored credential without asking to create one', async () => {
    // The refresh path: an access token expired, the refresh token was
    // exchanged with Google, and the result is written back. The secret is
    // already there — `tokens()` read it a moment ago, which is how the refresh
    // token was found at all.
    const { store: credentials } = store({ gmail__ada_lovelace: '{"refresh_token":"r"}' }, REVISION);

    await credentials.set('gmail/ada_lovelace', '{"refresh_token":"r","access_token":"fresh"}');

    expect(await credentials.get('gmail/ada_lovelace')).toContain('fresh');
  });

  test('writes the vault document, which is the one write ADR-022 grants outright', async () => {
    // `deploy` creates this secret itself and binds `secretVersionAdder` to it
    // alone, precisely so the revision never needs `secrets.create`. Creating
    // first asked for it anyway, so `vault put` was failing up there too —
    // through the same `set`, for the same reason, and unnoticed because the
    // grant looked right in `grants.test.ts`.
    const { store: credentials } = store({ vault__document: 'sealed-v1' }, REVISION);

    await credentials.set('vault/document', 'sealed-v2');

    expect(await credentials.get('vault/document')).toBe('sealed-v2');
  });

  test('spends one request when the secret is already there', async () => {
    const { store: credentials, api } = store({ gmail__main: 'stored' }, REVISION);

    await credentials.set('gmail/main', 'rotated');

    // Not a performance assertion. A create call that is never made is a
    // permission that is never needed, and the count is the only way to say
    // "did not ask" rather than "asked and tolerated the refusal".
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.path).toEndWith(':addVersion');
  });

  test('names the ref and the command when the secret has no binding yet', async () => {
    // A connection made after the last deploy: `connect` wrote the credential
    // into the store, but no binding exists on a secret that did not exist when
    // the deploy ran. Google says which permission was denied and cannot know
    // what grants it, so the adapter supplies that half.
    const { store: credentials } = store({}, { denied: [...REVISION.denied!, 'secretmanager.versions.add'] });

    await expect(credentials.set('gmail/added_later', 'x')).rejects.toThrow(
      /gmail\/added_later[\s\S]*lanes link deploy/,
    );
  });
});

describe('failures', () => {
  test('surfaces what Google said, because a 403 names the missing permission', async () => {
    const denied = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Permission "secretmanager.versions.access" denied for resource …',
          },
        }),
        { status: 403 },
      )) as unknown as typeof globalThis.fetch;

    const credentials = new GcpSecretManagerStore({
      project: PROJECT,
      fetch: denied,
      tokens: {
        async token() {
          return 't';
        },
      },
    });

    await expect(credentials.get('gmail/main')).rejects.toThrow(
      /PERMISSION_DENIED: Permission "secretmanager.versions.access" denied/,
    );
  });

  test('a project is required, and saying so beats a 404 from the API', () => {
    expect(() => new GcpSecretManagerStore({ project: '' })).toThrow(/needs a project/);
  });
});

describe('application default credentials', () => {
  test('GOOGLE_ACCESS_TOKEN wins, and costs no request', async () => {
    let requests = 0;
    const counted = (async () => {
      requests++;
      return new Response('{}');
    }) as unknown as typeof globalThis.fetch;

    const credentials = new ApplicationDefaultCredentials({
      fetch: counted,
      env: { GOOGLE_ACCESS_TOKEN: 'from-env' },
    });

    expect(await credentials.token()).toBe('from-env');
    expect(requests).toBe(0);
  });

  test('reads the metadata server when nothing else is configured', async () => {
    const seen: string[] = [];
    const metadata = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input));
      expect(new Headers(init?.headers).get('metadata-flavor')).toBe('Google');
      return new Response(JSON.stringify({ access_token: 'from-metadata', expires_in: 3599 }));
    }) as unknown as typeof globalThis.fetch;

    const credentials = new ApplicationDefaultCredentials({
      fetch: metadata,
      // A CLOUDSDK_CONFIG pointing nowhere makes the well-known lookup miss,
      // which is what a container looks like.
      env: { CLOUDSDK_CONFIG: '/nonexistent' },
    });

    expect(await credentials.token()).toBe('from-metadata');
    expect(seen[0]).toContain('metadata.google.internal');
  });

  test('caches until the token is nearly expired', async () => {
    let minted = 0;
    const counting = (async () => {
      minted++;
      return new Response(JSON.stringify({ access_token: `t${minted}`, expires_in: 3600 }));
    }) as unknown as typeof globalThis.fetch;

    const credentials = new ApplicationDefaultCredentials({
      fetch: counting,
      env: { CLOUDSDK_CONFIG: '/nonexistent' },
    });

    expect(await credentials.token()).toBe('t1');
    expect(await credentials.token()).toBe('t1');
    // A token per Secret Manager call would triple the request count on a cold
    // start, which is where the latency budget is already spent.
    expect(minted).toBe(1);
  });

  test('an unreachable metadata server says what to do about it', async () => {
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND metadata.google.internal');
    }) as unknown as typeof globalThis.fetch;

    const credentials = new ApplicationDefaultCredentials({
      fetch: offline,
      env: { CLOUDSDK_CONFIG: '/nonexistent' },
    });

    await expect(credentials.token()).rejects.toThrow(
      /gcloud auth application-default login.*GOOGLE_APPLICATION_CREDENTIALS/s,
    );
  });

  test('exchanges a gcloud user credential for an access token', async () => {
    const path = `${import.meta.dir}/.adc-authorized-user.test.json`;
    await Bun.write(
      path,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'csecret',
        refresh_token: 'rtoken',
      }),
    );

    try {
      let form: URLSearchParams | undefined;
      const oauth = (async (_input: string | URL | Request, init?: RequestInit) => {
        form = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({ access_token: 'exchanged', expires_in: 3600 }));
      }) as unknown as typeof globalThis.fetch;

      const credentials = new ApplicationDefaultCredentials({
        fetch: oauth,
        env: { GOOGLE_APPLICATION_CREDENTIALS: path },
      });

      expect(await credentials.token()).toBe('exchanged');
      expect(form?.get('grant_type')).toBe('refresh_token');
      expect(form?.get('refresh_token')).toBe('rtoken');
    } finally {
      await Bun.file(path).delete();
    }
  });

  test('refuses a credential file of a kind it cannot use', async () => {
    const path = `${import.meta.dir}/.adc-unknown.test.json`;
    await Bun.write(path, JSON.stringify({ type: 'external_account' }));

    try {
      const credentials = new ApplicationDefaultCredentials({
        env: { GOOGLE_APPLICATION_CREDENTIALS: path },
      });
      await expect(credentials.token()).rejects.toThrow(/unsupported Google credential type/);
    } finally {
      await Bun.file(path).delete();
    }
  });
});
