import { describe, expect, test } from 'bun:test';
import { createMemoryCredentials, createMemoryState } from '#stores/state/testing.ts';
import { defineProvider } from '#connectivity';
import type { ConnectionConfig } from '#profile';
import { applyReconcile, formatPlan, planIsNoop, planReconcile } from './reconcile.ts';

/**
 * Stand-in manifests, because where a credential lives is the manifest's answer.
 *
 * This used to be `(provider) => provider !== 'example'` — a boolean, which was
 * only ever enough to ask *whether* a credential was needed and never *where* it
 * was, so reconcile derived one ref while the request authorizer read another.
 */
const manifestFor = (provider: string) =>
  provider === 'example'
    ? defineProvider({ id: 'example', name: 'Example', connector: { kind: 'local' } })
    : defineProvider({
        id: provider,
        name: provider,
        connector: { kind: 'mcp', endpoint: 'https://upstream.test/mcp' },
        auth: { kind: 'oauth' },
      });

/**
 * Reconcile takes the accounts, not a profile.
 *
 * It always did in substance — every line of it walked `config.connections` —
 * and ADR-057 made that literal: connections belong to the workspace, so the
 * function that keeps their state in step is handed the rows rather than a
 * profile that happens to list them.
 */
const EXAMPLE_ONLY: ConnectionConfig[] = [
  { id: 'a', provider: 'example', account: 'Scratch' },
];

const WITH_GMAIL: ConnectionConfig[] = [
  { id: 'a', provider: 'example', account: 'Scratch' },
  {
    id: 'main',
    provider: 'gmail',
    account: 'personal@example.com',
    credential_ref: 'gmail/main',
  },
];

describe('first reconcile', () => {
  test('creates every declared connection', async () => {
    const state = createMemoryState();
    const plan = await planReconcile(EXAMPLE_ONLY, state, createMemoryCredentials());

    expect(plan.missingInDatabase).toEqual(['example.a']);
    expect(plan.actions).toEqual([
      { kind: 'create', connection: 'example.a', displayName: 'Scratch', status: 'active' },
    ]);

    await applyReconcile(EXAMPLE_ONLY, state, plan);
    expect(await state.connections.get('example', 'a')).toMatchObject({
      displayName: 'Scratch',
      status: 'active',
    });
  });

  test('is idempotent — running it again changes nothing', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials();

    await applyReconcile(
      EXAMPLE_ONLY,
      state,
      await planReconcile(EXAMPLE_ONLY, state, credentials),
    );

    const second = await planReconcile(EXAMPLE_ONLY, state, credentials);
    expect(planIsNoop(second)).toBe(true);
    expect(formatPlan(second)).toBe('No changes. Runtime state matches the declared config.');
  });
});

/**
 * A credential store that answers one ref the way Secret Manager answers a
 * secret the revision may not read: by throwing, not by saying no.
 *
 * This is the whole reason the test exists. `has` has two ways to mean "you
 * cannot use this credential" and only one of them is a return value. Secret
 * Manager answers a missing *binding* with 403 rather than 404 — deliberately,
 * so an identity cannot enumerate secrets by their error codes — and the
 * adapter returns null for the 404 and throws for the 403.
 */
function credentialsRefusing(ref: string, initial: Record<string, string> = {}) {
  const store = createMemoryCredentials(initial);
  const refuse = () => {
    throw new Error(
      `Secret Manager could not read ${ref} (HTTP 403). PERMISSION_DENIED: ` +
        "Permission 'secretmanager.versions.access' denied on resource (or it may not exist).",
    );
  };
  return {
    ...store,
    async get(asked: string) {
      if (asked === ref) refuse();
      return store.get(asked);
    },
    async has(asked: string) {
      if (asked === ref) refuse();
      return store.has(asked);
    },
  };
}

describe('a credential that cannot be read does not take the endpoint down', () => {
  /**
   * The failure this pins cost two revisions on a real target, and it is the
   * one `planReconcile`'s own doc comment promises cannot happen: "a missing
   * credential does NOT fail". It does not, for the 404 spelling. The 403
   * spelling threw out of `planReconcile`, through `openReconciled`'s catch —
   * which closes the runtimes and rethrows — and the container exited 1 before
   * binding its port, so every profile went down for one dead connection.
   *
   * 403 is not a rare case. It is what a revision gets for a secret whose
   * binding was never created, and what it gets for a secret that has been
   * deleted — which is how an OAuth grant that the vendor has revoked ends up
   * here, because invalidating one deletes the secret rather than a version.
   */
  test('an unreadable credential is unauthorized rather than an exception', async () => {
    const state = createMemoryState();

    const plan = await planReconcile(
      WITH_GMAIL,
      state,
      credentialsRefusing('gmail/main'),
      manifestFor,
    );

    expect(plan.unauthorized).toEqual(['gmail.main']);
    // And the rest of the workspace still reconciles, which is the point: one
    // connection nobody can read must not decide whether the others serve.
    expect(plan.actions).toContainEqual({
      kind: 'create',
      connection: 'example.a',
      displayName: 'Scratch',
      status: 'active',
    });
  });

  test('why it could not be read is kept, not swallowed', async () => {
    // Marking it unauthorized and saying nothing would trade a crash for a
    // silence: "you have not connected this" and "this deployment cannot read
    // what you connected" send an operator to completely different places, and
    // only the second is a fault in the deployment itself.
    const plan = await planReconcile(
      WITH_GMAIL,
      createMemoryState(),
      credentialsRefusing('gmail/main'),
      manifestFor,
    );

    expect(plan.unreadable).toHaveLength(1);
    expect(plan.unreadable[0]?.connection).toBe('gmail.main');
    expect(plan.unreadable[0]?.reason).toContain('403');
    expect(formatPlan(plan)).toContain('could not be read');
  });

  test('a credential that is merely absent is not reported as unreadable', async () => {
    // The two must stay distinguishable in both directions, or the new field
    // becomes noise on every unconnected account.
    const plan = await planReconcile(WITH_GMAIL, createMemoryState(), createMemoryCredentials());

    expect(plan.unauthorized).toEqual(['gmail.main']);
    expect(plan.unreadable).toEqual([]);
  });
});

describe('missing credentials do not block startup', () => {
  test('a connection with no stored credential becomes unauthorized, not an error', async () => {
    const state = createMemoryState();
    const plan = await planReconcile(WITH_GMAIL, state, createMemoryCredentials());

    expect(plan.unauthorized).toEqual(['gmail.main']);
    // The example connection is still created and active — one half-configured
    // account must not stop the rest of the profile from serving.
    expect(plan.actions).toContainEqual({
      kind: 'create',
      connection: 'example.a',
      displayName: 'Scratch',
      status: 'active',
    });
    expect(plan.actions).toContainEqual({
      kind: 'create',
      connection: 'gmail.main',
      displayName: 'personal@example.com',
      status: 'unauthorized',
    });
  });

  test('the plan tells you the command that fixes it', async () => {
    const state = createMemoryState();
    const plan = await planReconcile(WITH_GMAIL, state, createMemoryCredentials());
    expect(formatPlan(plan)).toContain('lanes link connect gmail.main');
  });

  test('connecting the account flips it to active on the next reconcile', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials();

    await applyReconcile(WITH_GMAIL, state, await planReconcile(WITH_GMAIL, state, credentials));
    expect(await state.connections.get('gmail', 'main')).toMatchObject({
      status: 'unauthorized',
    });

    await credentials.set('gmail/main', 'refresh-token');
    const plan = await planReconcile(WITH_GMAIL, state, credentials);

    expect(plan.actions).toContainEqual({
      kind: 'status',
      connection: 'gmail.main',
      from: 'unauthorized',
      to: 'active',
      reason: 'credential resolves',
    });

    await applyReconcile(WITH_GMAIL, state, plan);
    expect(await state.connections.get('gmail', 'main')).toMatchObject({ status: 'active' });
  });
});

describe('undeclared connections are disabled, never deleted', () => {
  // There is no `enabled` flag: declaring a connection is what enables it, and
  // deleting it is how you turn one off. A second place to say so could only
  // ever disagree with the connection's own existence.
  test('removing a connection from config disables it and preserves the row', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials({ 'gmail/main': 'refresh-token' });

    await applyReconcile(WITH_GMAIL, state, await planReconcile(WITH_GMAIL, state, credentials));
    expect(await state.connections.get('gmail', 'main')).toMatchObject({ status: 'active' });

    // Now config no longer declares gmail.main.
    const plan = await planReconcile(EXAMPLE_ONLY, state, credentials);
    expect(plan.undeclared).toEqual(['gmail.main']);
    expect(plan.actions).toContainEqual({
      kind: 'disable',
      connection: 'gmail.main',
      reason:
        'no longer declared in config; disabled rather than deleted to preserve audit history',
    });

    await applyReconcile(EXAMPLE_ONLY, state, plan);

    const record = await state.connections.get('gmail', 'main');
    expect(record).not.toBeNull();
    expect(record).toMatchObject({ status: 'disabled' });
  });

  test('an already-disabled connection is not disabled again', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials({ 'gmail/main': 'refresh-token' });

    await applyReconcile(WITH_GMAIL, state, await planReconcile(WITH_GMAIL, state, credentials));
    const first = await planReconcile(EXAMPLE_ONLY, state, credentials);
    await applyReconcile(EXAMPLE_ONLY, state, first);

    const second = await planReconcile(EXAMPLE_ONLY, state, credentials);
    expect(second.actions.some((a) => a.kind === 'disable')).toBe(false);
    expect(second.undeclared).toEqual(['gmail.main']); // still reported as drift
  });
});

describe('drift is reported in both directions', () => {
  test('names what config declares that the state lacks, and vice versa', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials({ 'gmail/main': 'refresh-token' });

    await applyReconcile(WITH_GMAIL, state, await planReconcile(WITH_GMAIL, state, credentials));

    const other: ConnectionConfig[] = [
    { id: 'a', provider: 'example', account: 'Scratch' },
    { id: 'b', provider: 'example', account: 'Second' },
  ];

    const plan = await planReconcile(other, state, credentials);
    expect(plan.missingInDatabase).toEqual(['example.b']);
    expect(plan.undeclared).toEqual(['gmail.main']);
  });
});

describe('renaming', () => {
  test('a changed account is an update, not a recreate', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials();

    await applyReconcile(
      EXAMPLE_ONLY,
      state,
      await planReconcile(EXAMPLE_ONLY, state, credentials),
    );
    const created = await state.connections.get('example', 'a');

    const renamed: ConnectionConfig[] = [
    { id: 'a', provider: 'example', account: 'Renamed' },
  ];

    const plan = await planReconcile(renamed, state, credentials);
    expect(plan.actions).toEqual([
      { kind: 'update', connection: 'example.a', changes: ['account'] },
    ]);

    await applyReconcile(renamed, state, plan);
    const after = await state.connections.get('example', 'a');
    expect(after?.displayName).toBe('Renamed');
    // Same row: createdAt survives, so audit history stays attached.
    expect(after?.createdAt).toEqual(created!.createdAt);
  });
});

describe('credential refs derive from the connection', () => {
  const derived: ConnectionConfig[] = [
    { id: 'ada_lovelace', provider: 'gmail', account: 'ada.lovelace@example.com' },
  ];

  test('an omitted ref resolves to <provider>/<id>', async () => {
    const state = createMemoryState();

    // Nothing stored: the derived ref is checked, so this is unauthorized
    // rather than silently "needs no credential".
    const missing = await planReconcile(
      derived,
      state,
      createMemoryCredentials(),
      manifestFor,
    );
    expect(missing.unauthorized).toEqual(['gmail.ada_lovelace']);

    const present = await planReconcile(
      derived,
      state,
      createMemoryCredentials({ 'gmail/ada_lovelace': 'token' }),
      manifestFor,
    );
    expect(present.unauthorized).toEqual([]);
  });

  test('a provider that authenticates nothing still needs no credential', async () => {
    const plan = await planReconcile(
      EXAMPLE_ONLY,
      createMemoryState(),
      createMemoryCredentials(),
      manifestFor,
    );
    expect(plan.unauthorized).toEqual([]);
  });

  /**
   * A connection's `credential_ref` widens what it may *reach*. It does not
   * move where its credential *lives*.
   *
   * This used to substitute, and the substitution was reported rather than
   * obeyed: `resolveSecretRefs` adds the ref to the allowlist and every path
   * that actually reads a credential — the OAuth refresh, `connect`,
   * `requirements`, `setup` — derives from the manifest and has never read this
   * field. So the status said one thing and the request did another, in both
   * directions, which is the failure `credentialRefFor` was written to end and
   * had reintroduced from the other side.
   */
  describe('a hand-placed ref on the connection', () => {
    const shared: ConnectionConfig[] = [
    { id: 'ada_lovelace', provider: 'gmail', account: 'ada.lovelace@example.com', credential_ref: 'google/shared' },
  ];

    test('does not stand in for the credential the connection authenticates with', async () => {
      const plan = await planReconcile(
        shared,
        createMemoryState(),
        createMemoryCredentials({ 'google/shared': 'token' }),
        manifestFor,
      );

      // Reported `active` before this, on a connection whose every call would
      // 401: the refresh path wants `gmail/ada_lovelace`, and nothing put one
      // there. Saying so is the whole job of this field.
      expect(plan.unauthorized).toEqual(['gmail.ada_lovelace']);
    });

    test('and does not withhold authorization from one that has it', async () => {
      const plan = await planReconcile(
        shared,
        createMemoryState(),
        createMemoryCredentials({ 'gmail/ada_lovelace': 'token' }),
        manifestFor,
      );

      // The other direction, and the worse one to debug: `doctor` says run
      // `connect`, `connect` writes the derived ref it already wrote, and the
      // report never changes.
      expect(plan.unauthorized).toEqual([]);
    });

    test('is the only candidate when the manifest derives none', async () => {
      // A `local` provider authenticates with nothing, so there is no derived
      // ref to disagree with — and `resolveSecretRefs` makes this connection's
      // whole allowlist, which `https://lanes.sh/docs/link/creating-a-provider` says outright.
      const local: ConnectionConfig[] = [
    { id: 'a', provider: 'example', account: 'Scratch', credential_ref: 'acme/api_key' },
  ];

      const missing = await planReconcile(
        local,
        createMemoryState(),
        createMemoryCredentials(),
        manifestFor,
      );
      expect(missing.unauthorized).toEqual(['example.a']);

      const present = await planReconcile(
        local,
        createMemoryState(),
        createMemoryCredentials({ 'acme/api_key': 'k' }),
        manifestFor,
      );
      expect(present.unauthorized).toEqual([]);
    });
  });
});

describe('reconnecting an account already held', () => {
  // The question this design exists to answer: connecting the same address
  // twice must repair the connection, not append beside it.
  test('is a no-op on the declared config', async () => {
    const state = createMemoryState();
    const credentials = createMemoryCredentials({ 'gmail/ada_lovelace': 'token' });

    const declared: ConnectionConfig[] = [
    { id: 'ada_lovelace', provider: 'gmail', account: 'ada.lovelace@example.com' },
  ];

    await applyReconcile(
      declared,
      state,
      await planReconcile(declared, state, credentials, manifestFor),
    );

    // connect re-runs: same account, so the same id, so the same single row.
    await credentials.set('gmail/ada_lovelace', 'fresher-token');
    const second = await planReconcile(declared, state, credentials, manifestFor);

    expect(planIsNoop(second)).toBe(true);
    expect((await state.connections.list()).length).toBe(1);
  });
});
