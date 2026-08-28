import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import type { ConnectionConfig, DeployConfig } from '#profile';
import type { CommandResult, DeployDriver } from './driver.ts';
import { bindConnectionCredentials, unboundRotatableRefs } from './bind.ts';

/**
 * That a connection made between two deploys is bound to the revision serving it.
 *
 * The gap this closes is not a wrong answer anywhere. `provisionSteps` binds the
 * connections the config held when it ran, `connect` adds one and binds nothing,
 * and every report in between says the connection is fine — because it is, for
 * about an hour. Read is unaffected, so it authorises and answers; only the
 * write on the far side of the first token refresh is denied, long after the
 * command that caused it.
 *
 * So these assert argv rather than an outcome: what matters is that the binding
 * a connect performs is the same binding a deploy would have performed, and the
 * only way for those to agree is for both to come out of the same function.
 */

const cloudrun = {
  platform: 'cloudrun',
  project: 'my-project',
  region: 'europe-west1',
  service: 'lanes-link',
  access: 'public',
  service_account: 'lanes-link-run@my-project.iam.gserviceaccount.com',
  min_instances: 0,
} as const satisfies DeployConfig;

const connection: ConnectionConfig = {
  provider: 'sheets',
  id: 'ada',
  account: 'ada@example.com',
} as ConnectionConfig;

/** An OAuth provider, so it has a credential the revision has to rewrite. */
const manifest = defineProvider({
  id: 'sheets',
  name: 'Sheets',
  connector: { kind: 'mcp', endpoint: 'https://sheets.example.com/mcp' },
  auth: { kind: 'oauth' },
});

/** Records what was run, and answers however the test says. */
function fakeDriver(answer: (argv: readonly string[]) => CommandResult): {
  driver: DeployDriver;
  calls: string[][];
} {
  const calls: string[][] = [];
  const driver = {
    tool: 'gcloud',
    plan: () => [],
    provision: () => Promise.resolve([]),
    run: (argv: readonly string[]): Promise<CommandResult> => {
      calls.push([...argv]);
      return Promise.resolve(answer(argv));
    },
  } as unknown as DeployDriver;
  return { driver, calls };
}

const OK: CommandResult = { ok: true, stdout: '', stderr: '' };

describe('binding a connection made since the last deploy', () => {
  test('grants the revision both read and rotate on its credential', async () => {
    const { driver, calls } = fakeDriver(() => OK);

    const outcome = await bindConnectionCredentials({
      deploy: cloudrun,
      target: 'cloud',
      connection,
      manifest,
      driver,
    });

    expect(outcome.failed).toBeUndefined();
    const roles = calls.map((argv) => argv[argv.indexOf('--role') + 1]).filter(Boolean);

    // Read is the half an older deployment's project-wide `secretAccessor`
    // happens to cover, which is exactly what made the failure partial and slow
    // to find. A deployment provisioned since that changed has neither.
    expect(roles).toContain('roles/secretmanager.secretAccessor');
    // The half that is never covered by anything else, and the one a token
    // refresh needs.
    expect(roles).toContain('roles/secretmanager.secretVersionAdder');

    // The secret is created here so the revision only ever needs to add a
    // version, never `secrets.create` — a project-level permission that would
    // let it mint credential references of its own.
    expect(calls.some((argv) => argv[0] === 'secrets' && argv[1] === 'create')).toBe(true);

    // Every binding names the revision's own service account, and every call
    // names the project. The create step carries no member, which is the point
    // of it: it exists so the binding below can stay resource-level.
    for (const argv of calls) expect(argv).toContain('--project');
    for (const argv of calls.filter((a) => a.includes('add-iam-policy-binding'))) {
      expect(argv.join(' ')).toContain(cloudrun.service_account);
    }
  });

  test('does nothing for a target that runs here', async () => {
    const { driver, calls } = fakeDriver(() => OK);

    const outcome = await bindConnectionCredentials({
      deploy: undefined,
      target: 'local',
      connection,
      manifest,
      driver,
    });

    expect(outcome.bound).toEqual([]);
    expect(outcome.skipped).toBeDefined();
    expect(calls).toEqual([]);
  });

  test('does nothing for a provider that authenticates with nothing', async () => {
    // "A provider needing no credential is authorized by construction"
    // (`reconcile.ts`), so there is no secret to bind and no gcloud to invoke.
    const { driver, calls } = fakeDriver(() => OK);
    const local = defineProvider({
      id: 'notes',
      name: 'Notes',
      connector: { kind: 'fs', root: '/tmp/notes' },
      auth: { kind: 'none' },
    });

    const outcome = await bindConnectionCredentials({
      deploy: cloudrun,
      target: 'cloud',
      connection: { provider: 'notes', id: 'main', account: 'Notes' } as ConnectionConfig,
      manifest: local,
      driver,
    });

    expect(outcome.bound).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('reports a refused binding rather than failing the connect', async () => {
    // By the time this runs the credential is in the store and the config is
    // about to be saved, so throwing would report "connect failed" about a
    // connect that happened. The operator gets the sentence and the command.
    const { driver } = fakeDriver((argv) =>
      argv.includes('add-iam-policy-binding')
        ? { ok: false, stdout: '', stderr: 'ERROR: PERMISSION_DENIED' }
        : OK,
    );

    const outcome = await bindConnectionCredentials({
      deploy: cloudrun,
      target: 'cloud',
      connection,
      manifest,
      driver,
    });

    expect(outcome.bound).toEqual([]);
    expect(outcome.failed).toContain('lanes link deploy --target cloud');
    expect(outcome.failed).toContain('rotate');
  });

  test('tolerates a secret that already exists', async () => {
    // The create step's success case on every run after the first. Only a
    // refused *binding* is worth reporting.
    const { driver } = fakeDriver((argv) =>
      argv[1] === 'create'
        ? { ok: false, stdout: '', stderr: 'ERROR: ALREADY_EXISTS' }
        : OK,
    );

    const outcome = await bindConnectionCredentials({
      deploy: cloudrun,
      target: 'cloud',
      connection,
      manifest,
      driver,
    });

    expect(outcome.failed).toBeUndefined();
    expect(outcome.bound.length).toBeGreaterThan(0);
  });
});

describe('finding a credential the revision cannot rewrite', () => {
  const policy = (roles: string[]): string =>
    JSON.stringify({
      bindings: roles.map((role) => ({ role, members: [`serviceAccount:${cloudrun.service_account}`] })),
    });

  const manifestFor = (id: string) => (id === 'sheets' ? manifest : undefined);

  test('names the ref that is granted read and not rotate', async () => {
    // The exact live shape: a project-level `secretAccessor` from an older
    // deployment covers the read, and only the per-secret write is missing. That
    // asymmetry is why the connection answers for an hour before it stops.
    const { driver } = fakeDriver(() => ({
      ok: true,
      stdout: policy(['roles/secretmanager.secretAccessor']),
      stderr: '',
    }));

    const found = await unboundRotatableRefs({
      deploy: cloudrun,
      target: 'cloud',
      connections: [connection],
      manifestFor,
      driver,
    });

    expect(found.unbound.length).toBeGreaterThan(0);
    expect(found.unavailable).toBeUndefined();
  });

  test('says nothing when the binding is there', async () => {
    const { driver } = fakeDriver(() => ({
      ok: true,
      stdout: policy([
        'roles/secretmanager.secretAccessor',
        'roles/secretmanager.secretVersionAdder',
      ]),
      stderr: '',
    }));

    expect(
      await unboundRotatableRefs({
        deploy: cloudrun,
        target: 'cloud',
        connections: [connection],
        manifestFor,
        driver,
      }),
    ).toEqual({ unbound: [] });
  });

  test('does not call a policy it could not read unbound', async () => {
    // "Could not look" and "is not granted" send an operator to different
    // places, and this check is a *problem* rather than a warning — so it has to
    // be trusted about the second one. A machine with no gcloud reports that it
    // could not check, and reports nothing else.
    const { driver } = fakeDriver(() => ({ ok: false, stdout: '', stderr: 'gcloud: not found' }));

    const found = await unboundRotatableRefs({
      deploy: cloudrun,
      target: 'cloud',
      connections: [connection],
      manifestFor,
      driver,
    });

    expect(found.unbound).toEqual([]);
    expect(found.unavailable).toContain('could not be read');
  });

  test('asks nothing at all for a target that runs here', async () => {
    const { driver, calls } = fakeDriver(() => ({ ok: true, stdout: '{}', stderr: '' }));

    expect(
      await unboundRotatableRefs({
        deploy: undefined,
        target: 'local',
        connections: [connection],
        manifestFor,
        driver,
      }),
    ).toEqual({ unbound: [] });
    expect(calls).toEqual([]);
  });
});
